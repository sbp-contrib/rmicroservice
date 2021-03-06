import { injectable, inject, interfaces } from 'inversify';
import { BehaviorSubject } from 'rxjs/BehaviorSubject';
import * as grpc from 'grpc';

import { Context } from './context';
import { Config } from './config';
import { Logger } from './logger';
import { ServiceResponse, ServiceHandlerFunction } from './service';
import { HealthManager } from './health';
import { ProtoConfig } from './proto-config';
import { MicroChassisError } from './errors';

export interface GrpcService {
  grpcMethod: string;
  handler: ServiceHandlerFunction<any>;
}

interface UnaryCall {
  cancelled: boolean;
  metadata: any;
  request: any;
}

interface MethodDefinition {
  originalName: string;
  path: string;
  requestStream: boolean;
  responseStream: boolean;
  requestType: Object;
  responseType: Object;
}

interface ServiceDefinition {
  service: {
    [method: string]: MethodDefinition;
  };
}

interface MessageDefinition {
  [key: string]: any;
}

interface ProtobufDefinition {
  [service: string]: ServiceDefinition | MessageDefinition; // reality it's either message or service entries
}

interface PackagedProtobufDefinition {
  [packageName: string]: ProtobufDefinition;
}

type CallbackFn = (error: { code: number, details?: string } | null, content: string | null) => any;

type HandlerFn = (call: UnaryCall, callback: CallbackFn) => any;

interface GrpcImplementation {
  [methodName: string]: HandlerFn;
};

@injectable()
export class GrpcServer {
  private server: any;
  private services: GrpcImplementation = {};
  private proto: PackagedProtobufDefinition | ProtobufDefinition;
  private health = new BehaviorSubject(false);

  constructor(
    @inject('protoconfig') private protoConfig: ProtoConfig,
    private config: Config,
    private logger: Logger,
    private healthManager: HealthManager
  ) {
    this.healthManager.registerCheck('GRPC server', this.health);
    this.proto = grpc.load(this.protoConfig.path);
  }

  public registerService(serviceFactory: interfaces.Factory<GrpcService>) {
    const serviceName = this.normalizeServiceName((<GrpcService>serviceFactory()).grpcMethod);
    this.logger.info(`Registering GRPC service: ${serviceName}`);

    if (!this.service[serviceName]) {
      throw new Error(`Trying to register unknown GRPC method: ${serviceName}`)
    }

    // Setup handler
    const handler: HandlerFn = (call, callback) => {
      this.logger.info(`GRPC request started ${serviceName}`);
      const context = this.createContext(call.metadata);
      const service = <GrpcService>serviceFactory();

      service.handler(context, call.request)
        .then((response: ServiceResponse | void) => {
          if (!response) {
            throw new Error('Empty response returned');
          }
          callback(null, response.content);
        })
        .catch((error: Error | MicroChassisError | undefined) => {
          const errorResponse = {
            code: grpc.status.INTERNAL,
            details: 'Internal server error'
          };
          if (error instanceof MicroChassisError) {
            errorResponse.details = error.content;
            errorResponse.code = error.grpcCode;
          } else if (error instanceof Error) {
            errorResponse.details = error.message;
          }

          this.logger.error(`Unexpected error when handling gRPC call: ${errorResponse.details}`, errorResponse);
          callback(errorResponse, null);
        });
    };
    this.services[serviceName] = handler;
  }

  private checkMissingServices(): void {
    const missingServices: Array<string> = Object.keys(this.service)
      .filter(propertyKey => this.service.hasOwnProperty(propertyKey))
      .filter(method => this.services[method] === undefined);
    if (missingServices.length > 0) {
      throw new Error(`Missing GRPC implementation of services: ${JSON.stringify(missingServices.toString())}`);
    }
  }

  public start(): void {
    this.checkMissingServices();

    this.server = new grpc.Server();
    this.server.addService(this.service, this.services);
    this.server.bind(`0.0.0.0:${this.config.get('grpcPort')}`, grpc.ServerCredentials.createInsecure());
    this.server.start();
    this.logger.info(`Grpc server started listening on: ${this.config.get('grpcPort')}`);

    // Notify the server is healhty
    this.health.next(true);
  }

  private get service() {
    let definition: ProtobufDefinition;

    if (this.protoConfig.package) {
      definition = this.proto[this.protoConfig.package];
    } else {
      definition = this.proto;
    }
    return (<ServiceDefinition>definition[this.protoConfig.service]).service
  }

  private createContext(metadata: Map<string, any>): Context {
    let token = metadata.get('authorization')[0] || '';

    // As a precaution if authorization header starts with Token strip it off
    if (token.indexOf('Token ') === 0) {
      token = token.split('Token ')[1];
    }

    return {
      token,
      requestId: metadata.get('request-id')[0],
      user: metadata.get('remoteuser')[0]
    }
  }

  // A small method to normalize names of the gRPC calls. This is
  // required since all 'CapitalizedMethodNames' defined in protobuf
  // will be turned into 'camelCasedMethodNames' by grpc library by
  // default. As a convenience for the user of this class we do the
  // conversion under the hood.
  private normalizeServiceName(name: string): string {
    return name[0].toLowerCase() + name.slice(1);
  }
}
