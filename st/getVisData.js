import {disableTracing} from "../src/tracing/tracing"


import whereDoesCharComeFrom from "../src/whereDoesCharComeFrom"
import getRootOriginAtChar from "../src/getRootOriginAtChar"
import { OriginPath, FromJSView } from "../src/ui/ui"
var _ = require("underscore")
var $ = require("jquery")
import exportElementOrigin from "../src/export-element-origin"


var ReactDOM = require("react-dom")
var React = require("react")


setTimeout(function(){
    if (window.isVis) {
        return;
    }

    disableTracing()

    var link = document.createElement("link")
    link.setAttribute("rel", "stylesheet")
    link.setAttribute("href", "/fromjs-internals/fromjs.css")
    document.body.appendChild(link)

    var container = document.createElement("div")
    var component;

    ReactDOM.render(<FromJSView ref={(c) => component = c}/>, container)
    document.body.appendChild(container)

    function shouldHandle(e){
        if ($(e.target).closest("#fromjs").length !== 0){
            return false
        }
        if ($(e.target).is("html, body")){
            return false
        }
        return true
    }

    $("*").off("click")
    $("*").click(function(e){
        if (!shouldHandle(e)) {return}
        e.stopPropagation();
        e.preventDefault();
        $(".fromjs-el-selected").removeClass(".fromjs-el-selected")
        $(this).addClass("fromjs-el-selected")
        component.display(this)
    })
    $("*").mouseenter(function(e){
        if (!shouldHandle(e)) {return}
        e.stopPropagation()
        $(".fromjs-el-hover").removeClass("fromjs-el-hover")
        $(e.target).addClass("fromjs-el-hover")
        component.setPreviewEl(e.target)
    })
    $("*").mouseleave(function(e){
        if (!shouldHandle(e)) {return}
        $(".fromjs-el-hover").removeClass("fromjs-el-hover")
        component.setPreviewEl(null)
    })


        console.log("k")


    return
}, 4000)
