import {
  LevelDBLogServer,
  HtmlToOperationLogMapping,
  LocStore,
  traverseDomOrigin
} from "@fromjs/core";
import { traverse } from "./src/traverse";
import StackFrameResolver from "./src/StackFrameResolver";
import * as fs from "fs";
import * as crypto from "crypto";
import * as path from "path";
import * as express from "express";
import * as bodyParser from "body-parser";
import * as WebSocket from "ws";
import { createProxy } from "./backend.createProxy";
import { BackendOptions } from "./BackendOptions";
import * as axios from "axios";
import * as responseTime from "response-time";
import { config } from "@fromjs/core";

let uiDir = require
  .resolve("@fromjs/ui")
  .split(/[\/\\]/g)
  .slice(0, -1)
  .join("/");
let coreDir = require
  .resolve("@fromjs/core")
  .split(/[\/\\]/g)
  .slice(0, -1)
  .join("/");
let fromJSInternalDir = path.resolve(__dirname + "/../fromJSInternal");

let startPageDir = path.resolve(__dirname + "/../start-page");

function ensureDirectoriesExist(options: BackendOptions) {
  const directories = [
    options.sessionDirectory,
    options.getCertDirectory(),
    options.getTrackingDataDirectory()
  ];
  directories.forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir);
    }
  });
}
function createBackendCerts(options: BackendOptions) {
  fs.mkdirSync(options.getBackendServerCertDirPath());
  const Forge = require("node-forge");
  const pki = Forge.pki;
  var keys = pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });

  var cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.validity.notBefore = new Date();
  cert.validity.notBefore.setDate(cert.validity.notBefore.getDate() - 1);
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(
    cert.validity.notBefore.getFullYear() + 10
  );
  cert.sign(keys.privateKey, Forge.md.sha256.create());

  fs.writeFileSync(
    options.getBackendServerCertPath(),
    pki.certificateToPem(cert)
  );
  fs.writeFileSync(
    options.getBackendServerPrivateKeyPath(),
    pki.privateKeyToPem(keys.privateKey)
  );
}

const DELETE_EXISTING_LOGS_AT_START = false;
const LOG_PERF = config.LOG_PERF;

export default class Backend {
  constructor(options: BackendOptions) {
    if (DELETE_EXISTING_LOGS_AT_START) {
      console.log(
        "deleting existing log data, this makes sure perf data is more comparable... presumably leveldb slows down with more data"
      );
      require("rimraf").sync(options.getLocStorePath());
      require("rimraf").sync(options.getTrackingDataDirectory());
    }
    ensureDirectoriesExist(options);

    // seems like sometimes get-folder-size runs into max call stack size exceeded, so disable it
    // getFolderSize(options.sessionDirectory, (err, size) => {
    //   console.log(
    //     "Session size: ",
    //     (size / 1024 / 1024).toFixed(2) +
    //       " MB" +
    //       " (" +
    //       path.resolve(options.sessionDirectory) +
    //       ")"
    //   );
    // });

    let sessionConfig;
    function saveSessionConfig() {
      fs.writeFileSync(
        options.getSessionJsonPath(),
        JSON.stringify(sessionConfig, null, 4)
      );
    }
    if (fs.existsSync(options.getSessionJsonPath())) {
      const json = fs.readFileSync(options.getSessionJsonPath()).toString();
      sessionConfig = JSON.parse(json);
    } else {
      sessionConfig = {
        accessToken: crypto.randomBytes(32).toString("hex")
      };
      saveSessionConfig();
    }

    var { bePort, proxyPort } = options;

    const app = express();

    if (LOG_PERF) {
      app.use(
        responseTime((req, res, time) => {
          console.log(req.method, req.url, time + "ms");
        })
      );
    }

    app.use(bodyParser.json({ limit: "250mb" }));

    if (!fs.existsSync(options.getBackendServerCertDirPath())) {
      createBackendCerts(options);
    }

    const http = require("http");
    const server = http.createServer(app);

    const wss = new WebSocket.Server({
      server
    });

    // Needed or else websocket connection doesn't work because of self-signed cert
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

    // "Access-Control-Allow-Origin: *" allows any website to send data to local server
    // but that might be bad, so limit access to code generated by Babel plugin
    app.verifyToken = function verifyToken(req) {
      const { authorization } = req.headers;
      const { accessToken } = sessionConfig;
      if (authorization !== accessToken) {
        throw Error(
          "Token invalid: " + authorization + " should be " + accessToken
        );
      }
    };

    function getProxy() {
      return proxyInterface;
    }

    const files = fs.existsSync(options.sessionDirectory + "/files.json")
      ? JSON.parse(
          fs.readFileSync(
            options.sessionDirectory + "/" + "files.json",
            "utf-8"
          )
        )
      : [];
    setInterval(() => {
      fs.writeFileSync(
        options.sessionDirectory + "/files.json",
        JSON.stringify(files, null, 2)
      );
    }, 5000);

    setupUI(options, app, wss, getProxy, files);
    let { storeLocs } = setupBackend(options, app, wss, getProxy, files);

    let proxyInterface;
    const proxyReady = createProxy({
      accessToken: sessionConfig.accessToken,
      options,
      storeLocs
    });
    proxyReady.then(pInterface => {
      proxyInterface = pInterface;
      "justtotest" && getProxy();
      if (options.onReady) {
        options.onReady();
      }
    });

    ["/storeLogs", "/inspect", "/inspectDOM"].forEach(path => {
      // todo: don't allow requests from any site
      app.options(path, allowCrossOriginRequests);
    });

    const serverReady = new Promise(resolve => {
      server.listen(bePort, () => resolve());
    });

    Promise.all([proxyReady, serverReady]).then(function() {
      console.log("Server listening on port " + bePort);
    });
  }
}

function setupUI(options, app, wss, getProxy, files) {
  wss.on("connection", (ws: WebSocket) => {
    // console.log("On ws connection");
    if (domToInspect) {
      ws.send(
        JSON.stringify({
          type: "inspectDOM",
          ...getDomToInspectMessage()
        })
      );
    } else if (logToInspect) {
      broadcast(
        wss,
        JSON.stringify({
          type: "inspectOperationLog",
          operationLogId: logToInspect
        })
      );
    }
  });

  app.get("/", (req, res) => {
    let html = fs.readFileSync(uiDir + "/index.html").toString();
    html = html.replace(/BACKEND_PORT_PLACEHOLDER/g, options.bePort.toString());
    getProxy()
      ._getEnableInstrumentation()
      .then(function(enabled) {
        html = html.replace(
          /BACKEND_PORT_PLACEHOLDER/g,
          options.bePort.toString()
        );
        html = html.replace(
          /ENABLE_INSTRUMENTATION_PLACEHOLDER/g,
          enabled.toString()
        );
        res.send(html);
      });
  });

  app.post("/makeProxyRequest", async (req, res) => {
    const url = req.body.url;
    console.log("px", { url });

    const r = await axios({
      url,
      method: req.body.method,
      headers: req.body.headers,
      validateStatus: status => true,
      transformResponse: data => data,
      proxy: {
        host: "127.0.0.1",
        port: options.proxyPort
      },
      data: req.body.postData
    });

    const data = r.data;
    const headers = r.headers;

    console.log("st", r.status);
    const hasha = require("hasha");
    const hash = hasha(data, "hex").slice(0, 8);

    let fileKey =
      url.replace(/\//g, "_").replace(/[^a-zA-Z\-_\.0-9]/g, "") + "_" + hash;

    files.push({
      url,
      hash,
      createdAt: new Date(),
      key: fileKey
    });

    res.status(r.status);

    Object.keys(headers).forEach(headerKey => {
      res.set(headerKey, headers[headerKey]);
    });

    res.end(Buffer.from(data));
  });

  app.get("/viewFile/", (req, res) => {});

  app.use(express.static(uiDir));
  app.use("/fromJSInternal", express.static(fromJSInternalDir));
  app.use((req, res, next) => {
    console.log("rrrr", req.url);
    next();
  });
  app.use("/start", express.static(startPageDir));

  function getDomToInspectMessage(charIndex?) {
    if (!domToInspect) {
      return {
        err: "Backend has no selected DOM to inspect"
      };
    }

    const mapping = new HtmlToOperationLogMapping((<any>domToInspect).parts);

    const html = mapping.getHtml();
    let goodDefaultCharIndex = 0;

    if (charIndex !== undefined) {
      goodDefaultCharIndex = charIndex;
    } else {
      const charIndexWhereTextFollows = html.search(/>[^<]/);
      if (
        charIndexWhereTextFollows !== -1 &&
        mapping.getOriginAtCharacterIndex(charIndexWhereTextFollows)
      ) {
        goodDefaultCharIndex = charIndexWhereTextFollows;
        goodDefaultCharIndex++; // the > char
        const first10Chars = html.slice(
          goodDefaultCharIndex,
          goodDefaultCharIndex + 10
        );
        const firstNonWhitespaceOffset = first10Chars.search(/\S/);
        goodDefaultCharIndex += firstNonWhitespaceOffset;
      }
    }

    return {
      html: (<any>domToInspect).parts.map(p => p[0]).join(""),
      charIndex: goodDefaultCharIndex
    };
  }

  let domToInspect = null;
  app.post("/inspectDOM", (req, res) => {
    app.verifyToken(req);

    res.set("Access-Control-Allow-Origin", "*");
    res.set(
      "Access-Control-Allow-Headers",
      "Content-Type, Access-Control-Allow-Headers, Authorization, X-Requested-With"
    );

    domToInspect = req.body;

    broadcast(
      wss,
      JSON.stringify({
        type: "inspectDOM",
        ...getDomToInspectMessage(req.body.charIndex)
      })
    );

    res.end("{}");
  });

  let logToInspect = null;
  app.post("/inspectDomChar", (req, res) => {
    if (!domToInspect) {
      res.status(500);
      res.json({
        err: "Backend has no selected DOM to inspect"
      });
      res.end();
      return;
    }

    const mapping = new HtmlToOperationLogMapping((<any>domToInspect).parts);
    const mappingResult: any = mapping.getOriginAtCharacterIndex(
      req.body.charIndex
    );

    if (!mappingResult.origin) {
      res.end(
        JSON.stringify({
          logId: null
        })
      );
      return;
    }

    const origin = mappingResult.origin;

    res.end(
      JSON.stringify({
        logId: origin.trackingValue,
        charIndex: traverseDomOrigin(origin, mappingResult.charIndex)
      })
    );
  });
  app.post("/inspect", (req, res) => {
    allowCrossOrigin(res);

    app.verifyToken(req);
    logToInspect = req.body.logId;
    res.end("{}");

    broadcast(
      wss,
      JSON.stringify({
        type: "inspectOperationLog",
        operationLogId: logToInspect
      })
    );
  });
}

function setupBackend(options: BackendOptions, app, wss, getProxy, files) {
  const locStore = new LocStore(options.getLocStorePath());
  const logServer = new LevelDBLogServer(
    options.getTrackingDataDirectory(),
    locStore
  );

  function getLocs(url) {
    return new Promise((resolve, reject) => {
      let locs: any[] = [];
      let i = locStore.db.iterator();
      function iterate(error, key, value) {
        if (value) {
          value = JSON.parse(value);
          if (value.url.includes(url)) {
            locs.push({ key: key.toString(), value });
          }
        }
        if (key) {
          i.next(iterate);
        } else {
          resolve(locs);
        }
      }
      i.next(iterate);
    });
  }

  app.get("/xyzviewer", async (req, res) => {
    res.end(`<!doctype html>
      <style>
      .myInlineDecoration {
        background: yellow;
        cursor: pointer;
      }
      </style>
      <script>
      window["backendPort"] =7000;
      </script>
      <div>
        <div id="container" style="width:600px;height:500px;border:1px solid grey; float:left"></div>
        <div id="app" style="float:left; width: 500px"></div>
        <div id="appx" style="float: left; width: 600px"></div>
      </div>
      <script src="http://localhost:7000/dist/bundle.js"></script>
    `);
  });

  app.get("/xyzviewer/fileInfo", (req, res) => {
    res.json(files);
  });

  app.get("/xyzviewer/fileDetails/:fileKey", async (req, res) => {
    let file = files.find(f => f.key === req.params.fileKey);
    let url = file.url;
    const { data: fileContent } = await axios.get(url);

    const locs = await getLocs(url);
    res.json({ fileContent, locs });
  });

  app.get("/xyzviewer/trackingDataForLoc/:locId", (req, res) => {
    let logs: any[] = [];
    let iterator = logServer.db.iterator();
    async function iterate(err, key, value) {
      if (value) {
        value = JSON.parse(value.toString());
        if (value.loc === req.params.locId) {
          const v2 = await logServer.loadLogAwaitable(
            parseFloat(value.index),
            0
          );
          logs.push({
            key: key.toString(),
            value: v2
          });
        }

        iterator.next(iterate);
      } else {
        res.json(logs);
      }
    }
    iterator.next(iterate);
  });

  app.get("/jsFiles/compileInBrowser.js", (req, res) => {
    const code = fs
      .readFileSync(coreDir + "/../compileInBrowser.js")
      .toString();
    res.end(code);
  });
  app.get("/jsFiles/babel-standalone.js", (req, res) => {
    const code = fs
      .readFileSync(coreDir + "/../babel-standalone.js")
      .toString();
    res.end(code);
  });

  app.post("/setEnableInstrumentation", (req, res) => {
    const { enableInstrumentation } = req.body;
    getProxy().setEnableInstrumentation(enableInstrumentation);

    res.end(JSON.stringify(req.body));
  });

  app.post("/storeLogs", (req, res) => {
    app.verifyToken(req);

    res.set("Access-Control-Allow-Origin", "*");
    res.set(
      "Access-Control-Allow-Headers",
      "Content-Type, Access-Control-Allow-Headers, Authorization, X-Requested-With"
    );

    const startTime = new Date();
    logServer.storeLogs(req.body.logs, function() {
      const timePassed = new Date().valueOf() - startTime.valueOf();
      const timePer1000 =
        Math.round((timePassed / req.body.logs.length) * 1000 * 10) / 10;
      if (LOG_PERF) {
        console.log(
          "storing logs took " +
            timePassed +
            "ms, per 1000 logs: " +
            timePer1000 +
            "ms"
        );
      }
    });

    req.body.evalScripts.forEach(function(evalScript) {
      getProxy().registerEvalScript(evalScript);
    });

    // fs.writeFileSync("logs.json", JSON.stringify(logServer._storedLogs));
    // console.log("stored logs", req.body.logs.length);

    res.end(JSON.stringify({ ok: true }));
  });

  app.post("/loadLog", (req, res) => {
    // crude way to first wait for any new logs to be sent through...
    setTimeout(function() {
      // console.log(Object.keys(internalServerInterface._storedLogs));
      console.log(req.body);
      logServer.loadLog(req.body.id, function(err, log) {
        res.end(JSON.stringify(log));
      });
    }, 500);
  });

  app.post("/traverse", (req, res) => {
    const { logId, charIndex } = req.body;
    const tryTraverse = (previousAttempts = 0) => {
      logServer.hasLog(logId, hasLog => {
        if (hasLog) {
          finishRequest();
        } else {
          const timeout = 250;
          const timeElapsed = timeout * previousAttempts;
          if (timeElapsed > 5000) {
            res.status(500);
            res.end(
              JSON.stringify({
                err: "Log not found (" + logId + ")- might still be saving data"
              })
            );
          } else {
            setTimeout(() => {
              tryTraverse(previousAttempts + 1);
            }, timeout);
          }
        }
      });
    };

    const finishRequest = async function finishRequest() {
      let steps;
      try {
        if (LOG_PERF) {
          console.time("Traverse " + logId);
        }
        steps = await traverse(
          {
            operationLog: logId,
            charIndex: charIndex
          },
          [],
          logServer,
          { optimistic: true }
        );
        if (LOG_PERF) {
          console.timeEnd("Traverse " + logId);
        }
      } catch (err) {
        res.status(500);
        res.end(
          JSON.stringify({
            err: "Log not found in backend (" + logId + ")"
          })
        );
      }

      res.end(JSON.stringify({ steps }));
    };

    tryTraverse();
  });

  const resolver = new StackFrameResolver({ proxyPort: options.proxyPort });

  app.get("/resolveStackFrame/:loc/:prettify?", (req, res) => {
    locStore.getLoc(req.params.loc, loc => {
      resolver
        .resolveFrameFromLoc(loc, req.params.prettify === "prettify")
        .then(rr => {
          res.end(JSON.stringify(rr, null, 4));
        });
    });
  });

  app.get("/viewFullCode/:url", (req, res) => {
    const url = decodeURIComponent(req.params.url);
    res.end(resolver.getFullSourceCode(url));
  });

  app.post("/instrument", (req, res) => {
    const code = req.body.code;

    getProxy()
      .instrumentForEval(code)
      .then(babelResult => {
        res.end(
          JSON.stringify({ instrumentedCode: babelResult.instrumentedCode })
        );
      });
  });

  return {
    storeLocs: locs => {
      locStore.write(locs, function() {});
    }
  };
}

function broadcast(wss, data) {
  wss.clients.forEach(function each(client) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

function allowCrossOriginRequests(req, res) {
  allowCrossOrigin(res);
  res.end();
}

function allowCrossOrigin(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Access-Control-Allow-Headers, Authorization, X-Requested-With"
  );
}

export { BackendOptions };
