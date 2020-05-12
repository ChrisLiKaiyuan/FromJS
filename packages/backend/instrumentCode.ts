// worker thread
import { compileSync } from "@fromjs/core";
import { expose } from "threads/worker";

Error.stackTraceLimit = Infinity;

var babel = require("@babel/core");
var path = require("path");
var fs = require("fs");

function instrumentCode() {
  // var babelPluginPath = path.resolve(analysisDirectory + "/babelPlugin.js");
  var babelPlugin = require("@fromjs/core").babelPlugin;

  var compilationFailures = [];
  // var envInitCode = fs
  //   .readFileSync(analysisDirectory + "/init.js", "utf-8")
  //   .toString();
  const startTime = new Date();

  return function processCode(code, url, babelPluginOptions) {
    // not an elegant solution, but it works
    // might be better anyway to do a string replace because then the helper code
    // won't change and the parse result can be cached in babel plugin
    // maybe move the helpercode logic out of babel altogether...
    babelPlugin.babelPluginOptions = babelPluginOptions;
    return new Promise((resolve, reject) => {
      // Include as part of the file rather than injecting into page
      // because there might be other environemnts being created
      // in iframes or web workers
      try {
        // console.time("[COMPILER] Compile " + url);
        const ret = compileSync(code, {}, url);

        resolve(ret);
        // console.timeEnd("[COMPILER] Compile " + url);
      } catch (err) {
        console.log("FAILED " + url, err);
        reject(err);
        throw err;
      }
    });
  };
}
async function instrument(args) {
  const body = args.body;

  const url = args.url;
  const babelPluginOptions = args.babelPluginOptions;
  var process = require("process");

  process.title = "FromJS - Compilation worker(" + url + ")";

  try {
    return await instrumentCode()(body, url, babelPluginOptions);
  } catch (err) {
    console.log("wil forward caught error")
    return {error: err}
  }
  
}

expose({
  instrument
});

module.exports = instrument;
