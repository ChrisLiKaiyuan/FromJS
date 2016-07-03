var endsWith = require("ends-with")
var StackTraceGPS = require("./stacktrace-gps")
var ErrorStackParser = require("./error-stack-parser")
import _ from "underscore"

var gps = null;
var defaultSourceCache = null

function resFrame(frame, callback){
    gps._get(frame.fileName).then(function(src){
        var lines = src.split("\n")
        frame.prevLine = lines[frame.lineNumber - 1 - 1]// adjust for lines being one-indexed
        frame.nextLine = lines[frame.lineNumber + 1 - 1]
        frame.line = lines[frame.lineNumber - 1];

        callback(null, JSON.parse(JSON.stringify(frame)))
    })

}

window.setDefaultSourceCache = setDefaultSourceCache
export function setDefaultSourceCache(sourceCache){
    defaultSourceCache = _.clone(sourceCache)
}

export function getDefaultSourceCache(){
    if (defaultSourceCache !== null) {
        return defaultSourceCache
    }

    var sourceCache = {};
    var fnEls = document.getElementsByClassName("string-trace-fn")
    fnEls = Array.prototype.slice.call(fnEls)
    fnEls.forEach(function(el){
        var key = el.getAttribute("fn") + ".js"
        sourceCache[key] = el.innerHTML
        sourceCache[key + "?dontprocess=yes"] = decodeURIComponent(el.getAttribute("original-source"))
        sourceCache[el.getAttribute("sm-filename")] = decodeURIComponent(el.getAttribute("sm"))
    })
    return sourceCache
}

function initGPSIfNecessary(){
    if (gps !== null) return

    gps = new StackTraceGPS({sourceCache: getDefaultSourceCache()});
    window.gps = gps
}



export default function(frame, callback){
    initGPSIfNecessary()

    var frameObject = ErrorStackParser.parse({stack: frame})[0];

    if (endsWith(frameObject.fileName, ".html")){
        // don't bother looking for source map file
        callback(null, frame)
    } else {
        gps.pinpoint(frameObject).then(function(newFrame){
            resFrame(newFrame, callback)
        }, function(){
            resFrame(frameObject, callback)
            console.log("error", arguments)
        });
    }
}