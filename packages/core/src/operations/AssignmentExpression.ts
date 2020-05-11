import { ExecContext } from "../helperFunctions/ExecContext";
import {
  getLastOperationTrackingResultCall,
  ignoredStringLiteral,
  runIfIdentifierExists,
  ignoredArrayExpression,
  createGetMemoArray,
  getLastOpValueCall,
  ignoredIdentifier,
  getTrackingVarName,
  ignoreNode,
  createSetMemoValue,
  getLastOperationTrackingResultWithoutResettingCall,
  getTrackingIdentifier,
  runIfTrackingIdentifierExists
} from "../babelPluginHelpers";
import traverseStringConcat from "../traverseStringConcat";
import mapInnerHTMLAssignment from "./domHelpers/mapInnerHTMLAssignment";
import addElOrigin, {
  addElAttributeValueOrigin,
  addElAttributeNameOrigin,
  trackSetElementStyle
} from "./domHelpers/addElOrigin";
import * as MemoValueNames from "../MemoValueNames";
import { consoleLog } from "../helperFunctions/logging";
import { safelyReadProperty } from "../util";
import * as OperationTypes from "../OperationTypes";
import { getShortOperationName } from "../names";

let assignmentExpressionName = getShortOperationName("assignmentExpression");

export default <any>{
  argNames: log => {
    if (log.astArgs.assignmentType === "MemberExpression") {
      return ["object", "propertyName", "argument"];
    } else {
      // e.g. "x += fn()" turns into [x, x+=mem(fn()), getMem()]
      return ["currentValue", "newValue", "argument"];
    }
  },
  canInferResult: (args, extraArgs, astArgs, runtimeArgs) => {
    if (astArgs.operator === "+=") {
      if (astArgs.type === "MemberExpression") {
        return !!runtimeArgs.assignment;
      } else {
        return (
          args[0][1] &&
          typeof args[0][0] === "string" &&
          args[2][1] &&
          typeof args[2][0] === "string"
        );
      }
    }
    return false;
  },
  exec: function AssignmentExpressionExec(
    args,
    astArgs,
    ctx: ExecContext,
    logData: any
  ) {
    var ret;
    const assignmentType = astArgs.type;
    const operator = astArgs.operator;
    if (assignmentType === "MemberExpression") {
      const [objArg, propertyNameArg, argumentArg] = args;
      var obj = objArg[0];
      var propName = propertyNameArg[0];
      var objT = objArg[1];
      var propNameT = propertyNameArg[1];

      var currentValue, currentValueT;
      if (operator !== "=") {
        // For simple assignment we don't need to know the current value,
        // avoid problems where getter sets a property value which would
        // cause infinite recursion
        currentValue = obj[propName];
        currentValueT = ctx.createOperationLog({
          operation: "memexpAsLeftAssExp",
          args: {
            object: [obj, objT],
            propertyName: [propName, propNameT]
          },
          extraArgs: {
            propertyValue: [
              currentValue,
              ctx.getObjectPropertyTrackingValue(obj, propName)
            ]
          },
          astArgs: {},
          result: currentValue,
          loc: logData.loc
        });
      }

      var argument = argumentArg[0];
      let newValue;
      switch (operator) {
        case "=":
          newValue = argument;
          break;
        case "+=":
          newValue = obj[propName] + argument;
          break;
        case "-=":
          newValue = obj[propName] - argument;
          break;
        case "*=":
          newValue = obj[propName] * argument;
          break;
        case "/=":
          newValue = obj[propName] / argument;
          break;
        case "|=":
          newValue = obj[propName] | argument;
          break;
        case "%=":
          newValue = obj[propName] % argument;
          break;
        case "&=":
          newValue = obj[propName] & argument;
          break;
        case "**=":
          newValue = obj[propName] ** argument;
          break;
        case "<<=":
          newValue = obj[propName] << argument;
          break;
        case ">>=":
          newValue = obj[propName] >> argument;
          break;
        case ">>>=":
          newValue = obj[propName] >>> argument;
          break;
        case "^=":
          newValue = obj[propName] ^ argument;
          break;
        default:
          throw Error("unknown operator " + operator);
      }
      obj[propName] = newValue;
      ret = newValue;

      const assignmentExpressionT = ctx.createOperationLog({
        result: ret,
        operation: assignmentExpressionName,
        args: [[currentValue, currentValueT], [newValue, null], argumentArg],
        astArgs: {
          operator,
          generated: true
        },
        loc: logData.loc
      });

      ctx.trackObjectPropertyAssignment(
        obj,
        propName,
        assignmentExpressionT,
        propNameT
      );
      logData.runtimeArgs = { assignment: assignmentExpressionT };

      const objIsHTMLNode = typeof Node !== "undefined" && obj instanceof Node;
      if (objIsHTMLNode) {
        if (propName === "innerHTML") {
          mapInnerHTMLAssignment(obj, argumentArg, "assignInnerHTML", 0);
        } else if (["text", "textContent", "nodeValue"].includes(propName)) {
          if (obj.nodeType === Node.TEXT_NODE) {
            addElOrigin(obj, "textValue", {
              trackingValue: argumentArg[1]
            });
          } else if (obj.nodeType === Node.ELEMENT_NODE) {
            if (obj.childNodes.length > 0) {
              // can be 0 still if textValue is ""
              addElOrigin(obj.childNodes[0], "textValue", {
                trackingValue: argumentArg[1]
              });
            }
          } else {
            // e.g. document fragments etc... should ideally handle this one day
          }
        } else if (
          // This is overly broad (and will track "elOrigins" for arbitraty property names),
          // but at least it makes sure all attributes are tracked
          safelyReadProperty(obj, "nodeType") === Node.ELEMENT_NODE &&
          typeof propName === "string"
        ) {
          let attrName = propName;
          if (attrName === "className") {
            attrName = "class";
          }
          addElAttributeValueOrigin(obj, attrName, {
            trackingValue: argumentArg[1]
          });
          addElAttributeNameOrigin(obj, attrName, { trackingValue: propNameT });
        }
      } else if (
        typeof CSSStyleDeclaration !== "undefined" &&
        obj instanceof CSSStyleDeclaration &&
        obj["__element"]
      ) {
        trackSetElementStyle(
          obj["__element"],
          propName,
          ctx.createOperationLog({
            operation: OperationTypes.styleAssignment,
            loc: logData.loc,
            args: {
              styleName: [null, propNameT],
              styleValue: argumentArg
            },
            result: propName + ": " + newValue
          })
        );
      }
    } else if (assignmentType === "Identifier") {
      const [currentValueArg, newValueArg, argumentArg] = args;
      ret = newValueArg[0];
    } else {
      throw Error("unknown: " + assignmentType);
    }
    return ret;
  },
  traverse(operationLog, charIndex) {
    const { operator } = operationLog.astArgs;
    if (operator === "=") {
      return {
        operationLog: operationLog.args.argument,
        charIndex: charIndex
      };
    } else if (operator === "+=") {
      if (operationLog.runtimeArgs && operationLog.runtimeArgs.assignment) {
        return {
          operationLog: operationLog.runtimeArgs.assignment,
          charIndex
        };
      }
      return traverseStringConcat(
        operationLog.args.currentValue,
        operationLog.args.argument,
        charIndex
      );
    } else {
      return;
    }
  },
  visitor(path) {
    path.node.ignore = true;

    const type = path.node.left.type;
    let operationArguments;

    let trackingAssignment: any = null;

    if (path.node.left.type === "MemberExpression") {
      var property;
      if (path.node.left.computed === true) {
        property = path.node.left.property;
      } else {
        property = this.t.stringLiteral(path.node.left.property.name);
        property.loc = path.node.left.property.loc;
      }

      operationArguments = [
        [path.node.left.object, getLastOperationTrackingResultCall()],
        [property, getLastOperationTrackingResultCall()],
        [path.node.right, getLastOperationTrackingResultCall()]
      ];
    } else if (path.node.left.type === "Identifier") {
      var right = createSetMemoValue(
        MemoValueNames.lastAssignmentExpressionArgument,
        path.node.right,
        getLastOperationTrackingResultCall()
      );
      path.node.right = right;

      trackingAssignment = runIfTrackingIdentifierExists(
        path.node.left.name,
        path.scope,
        ignoreNode(
          this.t.assignmentExpression(
            "=",
            getTrackingIdentifier(path.node.left.name),
            // Normally we want to reset the value after an operation, but the problem is
            // that after the tracking assignment the result value of the assignment operation could
            // be read.
            // Like this: `a = (b = 4)`
            // If we use reset the last tracking value the `a =` assignment will lose the tracking value
            // (In theory we could detect if the result is used somehow and only not reset if we know it's used
            // base on the AST)
            getLastOperationTrackingResultWithoutResettingCall()
          )
        )
      );

      const identifierAssignedTo = path.node.left;
      // we have to check if it exists because outside strict mode
      // you can assign to undeclared global variables
      const identifierValue = runIfTrackingIdentifierExists(
        identifierAssignedTo.name,
        path.scope,
        identifierAssignedTo
      );

      operationArguments = [
        [identifierValue, getLastOperationTrackingResultCall()],
        [path.node, getLastOperationTrackingResultCall()],
        createGetMemoArray(MemoValueNames.lastAssignmentExpressionArgument)
      ];
    } else if (path.node.left.type === "ObjectPattern") {
      console.log(
        "assignment expression with objectpattern - not handled right now"
      );
      return;
    } else if (path.node.left.type === "ArrayPattern") {
      console.log(
        "assignment expression with arraypattern - not handled right now"
      );
      return;
    } else {
      throw Error(
        "unhandled assignmentexpression node.left type " + path.node.left.type
      );
    }

    const operation = this.createNode!(
      operationArguments,
      {
        operator: ignoredStringLiteral(path.node.operator),
        type: ignoredStringLiteral(type)
      },
      path.node.loc
    );

    if (trackingAssignment) {
      path.replaceWith(
        this.t.sequenceExpression([
          operation,
          trackingAssignment,
          getLastOpValueCall()
        ])
      );
    } else {
      path.replaceWith(operation);
    }
  }
};
