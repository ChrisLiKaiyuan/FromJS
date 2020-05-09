import OperationLog from "../helperFunctions/OperationLog";
import { LogServer } from "./LogServer";
import { LocStore } from "../LocStore";

interface LogsObject {
  [key: string]: OperationLog;
}

export default class InMemoryLogServer extends LogServer {
  _storedLogs: LogsObject = {};
  constructor(locStore: LocStore) {
    super(locStore);
  }
  storeLog(log) {
    this._storedLogs[log.index] = log;
  }
  storeLogs(logs, callback = function() {}) {
    logs.forEach(log => this.storeLog(log));
    callback();
  }
  getLog(index: number, fn: (err: any, null: string | null) => void) {
    var log = this._storedLogs[index];
    if (!log) {
      fn(Error("log not found, index is: " + index), null);
      return;
    }

    // deep clone log so we can modify it without affecting the original
    // possibly slow, can fix later
    log = JSON.stringify(log);
    fn(null, log);
  }
}
