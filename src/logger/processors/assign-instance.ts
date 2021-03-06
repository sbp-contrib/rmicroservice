import { v4 as uuid } from 'uuid';
import { Config } from './../../config';
import { LogRecord } from './../logger';

let instanceId = uuid();

const func = function(config: Config) {
  if ((<any>config)['instanceId']) {
    instanceId = (<any>config)['instanceId'];
  }

  return (record: LogRecord): LogRecord => {
    if (instanceId !== undefined) {
      record.extra['instance-id'] = instanceId;
    }
    return record;
  };
}

export const assignInstanceId = func;
