const sub = require("./sub/sub")
const data = sub()
console.log(data)
let value = data.a
console.log("Inspect:" + __fromJSGetTrackingIndex(value));
__fromJSWaitForSendLogsAndExitNodeProcess()