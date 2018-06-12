import { babelPlugin, LevelDBLogServer } from "@fromjs/core";
import { traverse } from "./src/traverse";
import StackFrameResolver, {
  ResolvedStackFrame
} from "./src/StackFrameResolver";
import * as fs from "fs";
import * as prettier from "prettier";
import * as Babel from "babel-core";
import * as crypto from "crypto";
import * as path from "path";
import * as express from "express";
import * as bodyParser from "body-parser";
import * as WebSocket from "ws";
import * as http from "http";
import { createProxy } from "./backend.createProxy";
import { BackendOptions } from "./BackendOptions";
import { HtmlToOperationLogMapping } from "@fromjs/core";
import { template } from "lodash";
import * as ui from "@fromjs/ui";

export default class Backend {
  constructor(options: BackendOptions) {
    var { bePort, proxyPort } = options;

    const app = express();
    app.use(bodyParser.json({ limit: "250mb" }));
    const server = http.createServer(app);
    const wss = new WebSocket.Server({ server });

    wss.on("connection", (ws: WebSocket) => {
      ws.send(
        JSON.stringify({
          type: "connected"
        })
      );
    });

    // "Access-Control-Allow-Origin: *" allows any website to send data to local server
    // but that might be bad, so limit access to code generated by Babel plugin
    const accessToken = crypto.randomBytes(32).toString("hex");
    app.verifyToken = function verifyToken(req) {
      console.log(
        "not doing token verification right now, for better UX either just do redirect in proxy or save token somewhere"
      );
      // if (req.headers.authorization !== accessToken) {
      //   throw Error(
      //     "Token invalid: " +
      //       req.headers.authorization +
      //       " should be " +
      //       accessToken
      //   );
      // }
    };

    function getProxy() {
      console.log("getproxy", proxyInterface);
      return proxyInterface;
    }

    setupUI(options, app, wss, getProxy);
    setupBackend(options, app, wss, getProxy);

    let proxyInterface;
    createProxy({
      accessToken,
      options
    }).then(pInterface => {
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

    server.listen(bePort, () =>
      console.log("Backend server listening on port " + bePort)
    );
  }
}

function setupUI(options, app, wss, getProxy) {
  let uiDir = require
    .resolve("@fromjs/ui")
    .split("/")
    .slice(0, -1)
    .join("/");
  let startPageDir = path.resolve(__dirname + "/../start-page");

  app.get("/", (req, res) => {
    let html = fs.readFileSync(uiDir + "/index.html").toString();
    html = html.replace(/BACKEND_PORT_PLACEHOLDER/g, options.bePort.toString());
    res.send(html);
  });

  app.get("/start", (req, res) => {
    let html = fs.readFileSync(startPageDir + "/index.html").toString();
    const appJSCode = fs.readFileSync(startPageDir + "/app.js").toString();
    const escapedAppJSCode = template("<%- code %>")({ code: appJSCode });
    html = html.replace("APP_JS_CODE", escapedAppJSCode);
    res.send(html);
  });

  app.use(express.static(uiDir));
  app.use("/start", express.static(startPageDir));

  function getDomToInspectMessage() {
    if (!domToInspect) {
      return {};
    }

    const mapping = new HtmlToOperationLogMapping((<any>domToInspect).parts);

    const html = mapping.getHtml();
    let goodDefaultCharIndex = 0;
    const charIndexWhereTextFollows = html.search(/>[^<]/) + 1;
    if (
      charIndexWhereTextFollows !== -1 &&
      mapping.getOriginAtCharacterIndex(charIndexWhereTextFollows)
    ) {
      goodDefaultCharIndex = charIndexWhereTextFollows;
    }

    return {
      html: (<any>domToInspect).parts.map(p => p[0]).join(""),
      charIndex: goodDefaultCharIndex
    };
  }

  let domToInspect = null;
  app.get("/inspectDOM", (req, res) => {
    res.end(JSON.stringify(getDomToInspectMessage()));
  });
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
        ...getDomToInspectMessage()
      })
    );

    res.end("{}");
  });

  let logToInspect = null;
  app.get("/inspect", (req, res) => {
    res.end(
      JSON.stringify({
        logToInspect
      })
    );
  });
  app.post("/inspectDomChar", (req, res) => {
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

    if (
      mappingResult.origin.inputValuesCharacterIndex &&
      mappingResult.origin.inputValuesCharacterIndex.length > 1
    ) {
      debugger; // probably should do mapping for each char
    }

    res.end(
      JSON.stringify({
        logId: mappingResult.origin.trackingValue,
        charIndex:
          mappingResult.charIndex +
          mappingResult.origin.inputValuesCharacterIndex[0] -
          mappingResult.origin.extraCharsAdded
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

function setupBackend(options, app, wss, getProxy) {
  const logServer = new LevelDBLogServer();

  app.get("/jsFiles/compileInBrowser.js", (req, res) => {
    const code = fs
      .readFileSync(
        __dirname + "/../node_modules/@fromjs/core/compileInBrowser.js"
      )
      .toString();
    res.end(code);
  });
  app.get("/jsFiles/babel-standalone.js", (req, res) => {
    const code = fs
      .readFileSync(
        __dirname + "/../node_modules/@fromjs/core/babel-standalone.js"
      )
      .toString();
    res.end(code);
  });

  app.post("/storeLogs", (req, res) => {
    app.verifyToken(req);

    res.set("Access-Control-Allow-Origin", "*");
    res.set(
      "Access-Control-Allow-Headers",
      "Content-Type, Access-Control-Allow-Headers, Authorization, X-Requested-With"
    );

    req.body.logs.forEach(function(log) {
      logServer.storeLog(log);
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
    // crude way to first wait for any new logs to be sent through...
    setTimeout(async function() {
      console.log("traverse", req.body);
      console.time("loading log for traverse");

      // internalServerInterface.loadLog(req.body.logId, async function (log) {
      console.timeEnd("loading log for traverse");
      var steps = await traverse(
        {
          operationLog: req.body.logId,
          charIndex: req.body.charIndex
        },
        [],
        logServer
      );

      res.end(JSON.stringify({ steps }));
      // });
    }, 500);
  });

  const resolver = new StackFrameResolver({ proxyPort: options.proxyPort });

  app.post("/resolveStackFrame", (req, res) => {
    // const frameString = req.body.stackFrameString;

    const operationLog = req.body.operationLog;

    // use loc if available because sourcemaps are buggy...
    if (operationLog.loc) {
      resolver.resolveFrameFromLoc(operationLog.loc).then(rr => {
        res.end(JSON.stringify(rr));
      });
    } else {
      res.status(500);
      res.end(
        JSON.stringify({
          err:
            "not supporting non locs anymore, don't use sourcemap (" +
            operationLog.operation +
            ")"
        })
      );
      // resolver
      //   .resolveFrame(frameString)
      //   .then(rr => {
      //     res.end(JSON.stringify(rr));
      //   })
      //   .catch(err => {

      //   });
    }
  });

  app.post("/prettify", (req, res) => {
    res.end(
      JSON.stringify({
        code: prettier.format(req.body.code, { parser: "babylon" })
      })
    );
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
