import _ from 'lodash';
import { Logger } from 'winston';
import { v4 as uuid } from 'uuid';
import InvocationResult from './invocation-result';
import { Job, JobStatus } from '../job';
import DataOperation from '../data-operation';
import { defaultObjectStore } from '../../util/object-store';
import { ServerError } from '../../util/errors';
import db from '../../util/db';
import env from '../../util/env';

export interface ServiceCapabilities {
  subsetting?: {
    bbox?: boolean;
    variable?: boolean;
    multiple_variable?: true;
  };
  output_formats?: [string];
  reprojection?: boolean;
}

export interface ServiceConfig<ServiceParamType> {
  batch_size?: number;
  name?: string;
  data_operation_version?: string;
  type?: {
    name: string;
    params?: ServiceParamType;
  };
  collections?: string[];
  capabilities?: ServiceCapabilities;
  concurrency?: number;
  message?: string;
  maximum_sync_granules?: number;
}

/**
 * Returns the maximum number of synchronous granules a service allows
 * @param config - the service configuration
 */
export function getMaxSynchronousGranules(config: ServiceConfig<unknown>): number {
  const serviceLimit = _.get(config, 'maximum_sync_granules', env.maxSynchronousGranules);
  return Math.min(env.maxGranuleLimit, serviceLimit);
}

/**
 * Serialize the given operation with the given config.
 * @param op - The operation to serialize
 * @param config - The config to use when serializing the operation
 * @returns The serialized operation
 */
export function functionalSerializeOperation(
  op: DataOperation,
  config: ServiceConfig<unknown>,
): string {
  return op.serialize(config.data_operation_version);
}

/**
 * Abstract base class for services.  Provides a basic interface and handling of backend response
 * callback plumbing.
 *
 */
export default abstract class BaseService<ServiceParamType> {
  config: ServiceConfig<ServiceParamType>;

  params: ServiceParamType;

  operation: DataOperation;

  invocation: Promise<boolean>;

  /**
   * Creates an instance of BaseService.
   * @param config - The service configuration from config/services.yml
   * @param operation - The data operation being requested of the service
   */
  constructor(config: ServiceConfig<ServiceParamType>, operation: DataOperation) {
    this.config = config;
    const { type } = this.config;
    this.params = type?.params || ({} as ServiceParamType);
    this.operation = operation;
    this.operation.isSynchronous = this.isSynchronous;

    if (!this.operation.stagingLocation) {
      const prefix = `public/${config.name || this.constructor.name}/${uuid()}/`;
      this.operation.stagingLocation = defaultObjectStore().getUrlString(env.stagingBucket, prefix);
    }
  }

  /**
   * Returns the capabilities as specified in config/services.yml
   *
   * @readonly
   * @returns The service capabilities
   */
  get capabilities(): ServiceCapabilities {
    return this.config.capabilities;
  }

  /**
   * Invokes the service, returning a promise for the invocation result
   *
   * @param logger - The logger associated with this request
   * @param harmonyRoot - The harmony root URL
   * @param requestUrl - The URL the end user invoked
   *
   * @returns A promise resolving to the result of the callback.
   */
  async invokeOrAttach(
    logger?: Logger, harmonyRoot?: string, requestUrl?: string,
  ): Promise<InvocationResult> {
    let job: Job;
    logger.info('Invoking service for operation', { operation: this.operation });
    try {
      const startTime = new Date().getTime();
      logger.info('timing.save-job-to-database.start');
      job = await this._createJob(logger, requestUrl, this.operation.stagingLocation);
      await job.maybeAttach(db);
      if (job.attachedStatus.didAttach) {
        const { originalId, assumedId } = job.attachedStatus;
        logger.info(`This job attached to a previous job: ${originalId} is now ${assumedId}.`);
        this.operation.requestId = assumedId;
      }
      await job.save(db);
      const durationMs = new Date().getTime() - startTime;
      logger.info('timing.save-job-to-database.end', { durationMs });
    } catch (e) {
      logger.error(e.stack);
      throw new ServerError('Failed to save job to database.');
    }

    const { isAsync, requestId } = job;
    this.operation.callback = `${env.callbackUrlRoot}/service/${requestId}`;
    // If the current job attached to a running job then skip execution in the backend
    this['maybeRun'] = job.attachedStatus.didAttach
      ? async (): Promise<InvocationResult> => Promise.resolve(null) // eslint-disable-line
      : this._run;
    return new Promise((resolve, reject) => {
      this['maybeRun'](logger)
        .then((result) => {
          if (result) {
            // If running produces a result, use that rather than waiting for a callback
            resolve(result);
          } else if (isAsync) {
            resolve({ redirect: `/jobs/${requestId}`, headers: {} });
          } else {
            this._waitForSyncResponse(logger, requestId).then(resolve).catch(reject);
          }
        })
        .catch(reject);
    });
  }

  /**
   * Waits for a synchronous service invocation to complete by polling its job record,
   * then returns its result
   *
   * @param logger - The logger used for the request
   * @param requestId - The request ID
   * @returns - An invocation result corresponding to a synchronous service response
   */
  protected async _waitForSyncResponse(
    logger: Logger,
    requestId: string,
  ): Promise<InvocationResult> {
    let result: InvocationResult;
    try {
      let job: Job;
      do {
        // Sleep and poll for completion.  We could also use SNS or similar for a faster response
        await new Promise((resolve) => setTimeout(resolve, env.syncRequestPollIntervalMs));
        ({ job } = await Job.byRequestId(db, requestId));
      } while (!job.isComplete());

      if (job.status === JobStatus.FAILED) {
        result = { error: job.message };
      }

      if (job.status === JobStatus.SUCCESSFUL) {
        const links = job.getRelatedLinks('data');
        if (links.length === 1) {
          result = { redirect: links[0].href };
        } else {
          result = { error: `The backend service provided ${links.length} outputs when 1 was required`, statusCode: 500 };
        }
      }
    } catch (e) {
      logger.error(e);
      result = { error: 'The service request failed due to an internal error', statusCode: 500 };
    }
    return result;
  }

  /**
   * Abstract method used by invoke() to simplify implementation of async invocations.
   * Subclasses must implement this method if using the default invoke() implementation.
   * The method will be invoked asynchronously, completing when the service's callback is
   * received.
   * @param _logger - the logger associated with the request
   */
  protected abstract _run(_logger: Logger): Promise<InvocationResult>;

  /**
   * Creates a new job for this service's operation, with appropriate logging, errors,
   * and warnings.
   *
   * @param transaction - The transaction to use when creating the job
   * @param logger - The logger associated with this request
   * @param requestUrl - The URL the end user invoked
   * @param stagingLocation - The staging location for this job
   * @returns The created job
   * @throws ServerError - if the job cannot be created
   */
  protected async _createJob(
    logger: Logger,
    requestUrl: string,
    stagingLocation: string,
  ): Promise<Job> {
    const { geojson, requestId, user } = this.operation;
    const shapeFileUrl = geojson || '';
    logger.info(`Creating job for ${requestId}`);
    const job = new Job({
      username: user,
      requestId,
      jobID: requestId,
      status: JobStatus.RUNNING,
      request: requestUrl,
      isAsync: !this.isSynchronous,
      numInputGranules: this.numInputGranules,
      message: this.operation.message,
      shapeFileUrl,
    });
    job.addStagingBucketLink(stagingLocation);
    return job;
  }

  /**
   * Returns true if a request should be handled synchronously, false otherwise
   *
   * @returns true if the request is synchronous, false otherwise
   *
   */
  get isSynchronous(): boolean {
    const { operation } = this;

    if (operation.requireSynchronous) {
      return true;
    }
    if (operation.isSynchronous !== undefined) {
      return operation.isSynchronous;
    }

    let numResults = this.operation.cmrHits;

    if (operation.maxResults) {
      numResults = Math.min(numResults, operation.maxResults);
    }

    return numResults <= this.maxSynchronousGranules;
  }

  /**
   * Returns the maximum number of synchronous granules for this service
   */
  get maxSynchronousGranules(): number {
    return getMaxSynchronousGranules(this.config);
  }

  /**
   * Returns the number of input granules for this operation
   *
   * @returns the number of input granules for this operation
   * @readonly
   */
  get numInputGranules(): number {
    return Math.min(this.operation.cmrHits,
      this.operation.maxResults || Number.MAX_SAFE_INTEGER,
      env.maxGranuleLimit);
  }

  /**
   * Return the message to be sent to the service, describing the operation to be performed
   *
   * @returns the serialized message to be sent
   */
  serializeOperation(): string {
    const { operation, config } = this;
    return functionalSerializeOperation(operation, config);
  }
}
