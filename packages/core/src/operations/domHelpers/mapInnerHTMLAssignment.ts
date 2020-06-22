import addElOrigin, {
  addElAttributeValueOrigin,
  addElAttributeNameOrigin
} from "./addElOrigin";
import { normalizeHtml, normalizeHtmlAttribute } from "./normalize";
import { consoleWarn } from "../../helperFunctions/logging";

var htmlEntityRegex = /^\&[#a-zA-Z0-9]+\;/;
var whitespaceRegex = /^[\s]+/;
var tagEndRegex = /^(\s+)\/?>/;
// var twoQuoteSignsRegex = /^['"]{2}/;

const LOG_MAPPING = true;

const config = {
  validateHtmlMapping: true
};

function tagTypeHasClosingTag(tagName) {
  try {
    return document.createElement(tagName).outerHTML.indexOf("></") !== -1;
  } catch (err) {
    // For CustomElements createElement fails sometimes
    return true;
  }
}

// tries to describe the relationship between an assigned innerHTML value
// and the value you get back when reading el.innerHTML.
// e.g. you could assign "<input type='checkbox' checked>" and get back
// "<input type='checkbox' checked=''>"
// essentially this function serializes the elements content and compares it to the
// assigned value
export default function mapInnerHTMLAssignment(
  el,
  assignedInnerHTML,
  actionName,
  initialExtraCharsValue,
  contentEndIndex = assignedInnerHTML[0].length,
  nodesToIgnore: any[] = []
) {
  var serializedHtml = el.innerHTML;
  var forDebuggingProcessedHtml = "";
  var charOffsetInSerializedHtml = 0;
  var charsAddedInSerializedHtml = 0;
  if (initialExtraCharsValue !== undefined) {
    charsAddedInSerializedHtml = initialExtraCharsValue;
  }
  var assignedString = assignedInnerHTML[0];

  // if (contentEndIndex === 0) {
  //   contentEndIndex = assignedString.length
  // }
  // if (nodesToIgnore === undefined) {
  //   nodesToIgnore = [];
  // }

  var error = Error(); // used to get stack trace, rather than capturing a new one every time
  processNewInnerHtml(el);

  function getCharOffsetInAssignedHTML() {
    return charOffsetInSerializedHtml - charsAddedInSerializedHtml;
  }

  // get offsets by looking at how the assigned value compares to the serialized value
  // e.g. accounts for differeces between assigned "&" and serialized "&amp;"
  function getCharMappingOffsets(
    textAfterAssignment,
    charOffsetAdjustmentInAssignedHtml,
    tagName
  ) {
    if (charOffsetAdjustmentInAssignedHtml === undefined) {
      charOffsetAdjustmentInAssignedHtml = 0;
    }
    var offsets: any[] | undefined = [];
    var extraCharsAddedHere = 0;

    for (var i = 0; i < textAfterAssignment.length; i++) {
      offsets.push(-extraCharsAddedHere);
      var char = textAfterAssignment[i];

      var htmlEntityMatchAfterAssignment = textAfterAssignment
        .substr(i, 30)
        .match(htmlEntityRegex);

      var posInAssignedString =
        charOffsetInSerializedHtml +
        i -
        charsAddedInSerializedHtml +
        charOffsetAdjustmentInAssignedHtml -
        extraCharsAddedHere;
      if (posInAssignedString >= contentEndIndex) {
        // http://stackoverflow.com/questions/38892536/why-do-browsers-append-extra-line-breaks-at-the-end-of-the-body-tag
        break; // just don't bother for now
      }

      var textIncludingAndFollowingChar = assignedString.substr(
        posInAssignedString,
        30
      ); // assuming that no html entity is longer than 30 chars
      if (char === "\n" && textIncludingAndFollowingChar[0] == "\r") {
        extraCharsAddedHere--;
      }

      var htmlEntityMatch = textIncludingAndFollowingChar.match(
        htmlEntityRegex
      );

      if (
        tagName === "NOSCRIPT" &&
        htmlEntityMatchAfterAssignment !== null &&
        htmlEntityMatch !== null
      ) {
        // NOSCRIPT assignments: "&amp;" => "&amp;amp;", "&gt;" => "&amp;gt;"
        // so we manually advance over the "&amp;"
        for (var n = 0; n < "amp;".length; n++) {
          i++;
          extraCharsAddedHere++;
          offsets.push(-extraCharsAddedHere);
        }
        offsets.push(-extraCharsAddedHere);
      }

      if (htmlEntityMatchAfterAssignment !== null && htmlEntityMatch === null) {
        // assigned a character, but now it shows up as an entity (e.g. & ==> &amp;)
        var entity = htmlEntityMatchAfterAssignment[0];
        for (var n = 0; n < entity.length - 1; n++) {
          i++;
          extraCharsAddedHere++;
          offsets.push(-extraCharsAddedHere);
        }
      }

      if (htmlEntityMatchAfterAssignment === null && htmlEntityMatch !== null) {
        // assigned an html entity but now getting character back (e.g. &raquo; => »)
        var entity = htmlEntityMatch[0];
        extraCharsAddedHere -= entity.length - 1;
      }
    }

    if (offsets.length === 0) {
      offsets = undefined;
    }
    return {
      offsets: offsets,
      extraCharsAddedHere: extraCharsAddedHere
    };
  }

  function processNewInnerHtml(el) {
    var children;
    if (el.tagName === "TEMPLATE") {
      children = el.content.childNodes;
    } else {
      children = Array.prototype.slice.apply(el.childNodes, []);
    }
    addElOrigin(el, "replaceContents", {
      action: actionName,
      children: children
    });

    var childNodesToProcess: any[] = [].slice.call(children);

    childNodesToProcess = childNodesToProcess.filter(function(childNode) {
      var shouldIgnore = nodesToIgnore.indexOf(childNode) !== -1;
      return !shouldIgnore;
    });

    childNodesToProcess.forEach(function(child) {
      var isTextNode = child.nodeType === 3;
      var isCommentNode = child.nodeType === 8;
      var isElementNode = child.nodeType === 1;

      if (LOG_MAPPING) {
        console.log(
          "assigned_",
          assignedString
            .substr(getCharOffsetInAssignedHTML(), 100)
            .replace(/\n/g, "\\n")
        );
        if (isTextNode) {
          console.log(
            "text_____",
            (child.textContent || "").replace(/\n/g, "\\n").slice(0, 100)
          );
        } else if (isCommentNode) {
          console.log(
            "comment  ",
            "<!--" +
              (child.textContent || "").replace(/\n/g, "\\n").slice(0, 100) +
              "-->"
          );
        } else {
          console.log(
            "outerHTML",
            child.outerHTML &&
              child.outerHTML.replace(/\n/g, "\\n").slice(0, 100)
          );
        }
      }

      if (isTextNode) {
        var text = child.textContent;
        text = normalizeHtml(text, child.parentNode.tagName);
        var res = getCharMappingOffsets(text, 0, child.parentNode.tagName);
        var offsets = res.offsets;
        var extraCharsAddedHere = res.extraCharsAddedHere;

        addElOrigin(child, "textValue", {
          action: actionName,
          trackingValue: assignedInnerHTML[1],
          value: serializedHtml,
          inputValuesCharacterIndex: [charOffsetInSerializedHtml],
          extraCharsAdded: charsAddedInSerializedHtml,
          offsetAtCharIndex: offsets,
          error: error
        });

        charsAddedInSerializedHtml += extraCharsAddedHere;
        charOffsetInSerializedHtml += text.length;
        forDebuggingProcessedHtml += text;
      } else if (isCommentNode) {
        addElOrigin(child, "commentStart", {
          action: actionName,
          trackingValue: assignedInnerHTML[1],
          inputValuesCharacterIndex: [charOffsetInSerializedHtml],
          value: serializedHtml
        });

        charOffsetInSerializedHtml += "<!--".length;
        forDebuggingProcessedHtml += "<!--";

        addElOrigin(child, "textValue", {
          value: serializedHtml,
          trackingValue: assignedInnerHTML[1],
          inputValuesCharacterIndex: [charOffsetInSerializedHtml],
          action: actionName,
          error: error
        });
        charOffsetInSerializedHtml += child.textContent.length;
        forDebuggingProcessedHtml += child.textContent;

        addElOrigin(child, "commentEnd", {
          action: actionName,
          trackingValue: assignedInnerHTML[1],
          inputValuesCharacterIndex: [charOffsetInSerializedHtml],
          value: serializedHtml
        });
        charOffsetInSerializedHtml += "-->".length;
        forDebuggingProcessedHtml += "-->";
      } else if (isElementNode) {
        addElOrigin(child, "openingTagStart", {
          action: actionName,
          trackingValue: assignedInnerHTML[1],
          inputValuesCharacterIndex: [charOffsetInSerializedHtml],
          value: serializedHtml,
          extraCharsAdded: charsAddedInSerializedHtml,
          error: error
        });
        var openingTagStart = "<" + child.tagName;
        charOffsetInSerializedHtml += openingTagStart.length;
        forDebuggingProcessedHtml += openingTagStart;

        for (var i = 0; i < child.attributes.length; i++) {
          let extraCharsAddedHere = 0;
          var attr = child.attributes[i];

          var charOffsetInSerializedHtmlBefore = charOffsetInSerializedHtml;

          var whitespaceBeforeAttributeInSerializedHtml = " "; // always the same
          var assignedValueFromAttrStartOnwards = assignedString.substr(
            getCharOffsetInAssignedHTML(),
            100
          );
          var whitespaceMatches = assignedValueFromAttrStartOnwards.match(
            whitespaceRegex
          );

          var whitespaceBeforeAttributeInAssignedHtml;
          if (whitespaceMatches !== null) {
            whitespaceBeforeAttributeInAssignedHtml = whitespaceMatches[0];
          } else {
            // something broke, but better to show a broken result than nothing at all
            if (config.validateHtmlMapping) {
              consoleWarn(
                "no whitespace found at start of",
                assignedValueFromAttrStartOnwards
              );
            }
            whitespaceBeforeAttributeInAssignedHtml = "";
          }

          var attrStr = attr.name;
          var textAfterAssignment: any = normalizeHtmlAttribute(
            attr.textContent
          );
          attrStr += "='" + textAfterAssignment + "'";

          var offsetAtCharIndex: number[] = [];

          var extraWhitespaceBeforeAttributeInAssignedHtml =
            whitespaceBeforeAttributeInAssignedHtml.length -
            whitespaceBeforeAttributeInSerializedHtml.length;
          extraCharsAddedHere -= extraWhitespaceBeforeAttributeInAssignedHtml;

          offsetAtCharIndex.push(-extraCharsAddedHere); // char index for " " before attr

          var offsetInAssigned =
            getCharOffsetInAssignedHTML() +
            whitespaceBeforeAttributeInAssignedHtml.length;

          // add mapping for attribute name
          for (var charIndex in attr.name) {
            offsetAtCharIndex.push(-extraCharsAddedHere);
          }
          offsetInAssigned += attr.name.length;

          var nextCharacters = assignedString.substr(offsetInAssigned, 50);
          var equalsSignIsNextNonWhitespaceCharacter = /^[\s]*=/.test(
            nextCharacters
          );

          if (!equalsSignIsNextNonWhitespaceCharacter) {
            if (attr.textContent !== "") {
              consoleWarn("empty text content");
              // debugger
            }
            // value of attribute is omitted in original html
            const eqQuoteQuote: any = '=""';
            for (var charIndex in eqQuoteQuote) {
              extraCharsAddedHere++;
              offsetAtCharIndex.push(-extraCharsAddedHere);
            }
          } else {
            var whitespaceBeforeEqualsSign = nextCharacters.match(
              /^([\s]*)=/
            )[1];
            extraCharsAddedHere -= whitespaceBeforeEqualsSign.length;
            offsetInAssigned += whitespaceBeforeEqualsSign.length;

            // map `=` character
            offsetAtCharIndex.push(-extraCharsAddedHere);
            offsetInAssigned += "=".length;

            var nextCharacters = assignedString.substr(offsetInAssigned, 50);
            var whitespaceBeforeNonWhiteSpace = nextCharacters.match(
              /^([\s]*)[\S]/
            )[1];
            extraCharsAddedHere -= whitespaceBeforeNonWhiteSpace.length;
            offsetInAssigned += whitespaceBeforeNonWhiteSpace.length;

            // map `"` character
            offsetAtCharIndex.push(-extraCharsAddedHere);
            offsetInAssigned += '"'.length;

            var charOffsetAdjustmentInAssignedHtml =
              offsetInAssigned - getCharOffsetInAssignedHTML();
            var res = getCharMappingOffsets(
              textAfterAssignment,
              charOffsetAdjustmentInAssignedHtml,
              child.tagName
            );

            if (res.offsets === undefined) {
              // Pretty sure this can only happen if there is a bug further up, but for now
              // allow it to happen rather than breaking everything
              // specifically this was happening on StackOverflow, probably because we don't
              // support tables yet (turn <table> into <table><tbody>),
              // but once that is supported this might just fix itself
              consoleWarn("No offsets for attribute mapping");
              for (let ii = 0; ii < textAfterAssignment.length; ii++) {
                offsetAtCharIndex.push(-extraCharsAddedHere);
              }
            } else {
              res.offsets.forEach(function(offset, i) {
                offsetAtCharIndex.push(offset - extraCharsAddedHere);
              });
              extraCharsAddedHere += res.extraCharsAddedHere;
            }

            var lastOffset = offsetAtCharIndex[offsetAtCharIndex.length - 1];
            offsetAtCharIndex.push(lastOffset); // map the "'" after the attribute value
          }

          addElAttributeNameOrigin(child, attr.name, {
            action: actionName,
            trackingValue: assignedInnerHTML[1],
            value: serializedHtml,
            inputValuesCharacterIndex: [charOffsetInSerializedHtmlBefore],
            extraCharsAdded: charsAddedInSerializedHtml,
            offsetAtCharIndex: offsetAtCharIndex,
            error: error
          });

          addElAttributeValueOrigin(child, attr.name, {
            action: actionName,
            trackingValue: assignedInnerHTML[1],
            value: serializedHtml,
            inputValuesCharacterIndex: [
              charOffsetInSerializedHtmlBefore + (" " + attr.name).length
            ],
            extraCharsAdded: charsAddedInSerializedHtml,
            offsetAtCharIndex: offsetAtCharIndex,
            error: error
          });

          charsAddedInSerializedHtml += extraCharsAddedHere;

          charOffsetInSerializedHtml +=
            whitespaceBeforeAttributeInSerializedHtml.length + attrStr.length;
          forDebuggingProcessedHtml +=
            whitespaceBeforeAttributeInSerializedHtml + attrStr;
        }

        var openingTagEnd = ">";

        var assignedStringFromCurrentOffset = assignedString.substr(
          getCharOffsetInAssignedHTML(),
          200
        );
        if (assignedStringFromCurrentOffset === "") {
          // debugger;
        }
        var matches = assignedStringFromCurrentOffset.match(tagEndRegex);
        var whitespaceBeforeClosingAngleBracketInAssignedHTML = "";
        if (matches !== null) {
          // something like <div > (with extra space)
          // this char will not show up in the re-serialized innerHTML
          whitespaceBeforeClosingAngleBracketInAssignedHTML = matches[1];
        }
        charsAddedInSerializedHtml -=
          whitespaceBeforeClosingAngleBracketInAssignedHTML.length;

        if (!tagTypeHasClosingTag(child.tagName)) {
          if (assignedString[getCharOffsetInAssignedHTML()] === "/") {
            // something like <div/>
            // this char will not show up in the re-serialized innerHTML
            charsAddedInSerializedHtml -= 1;
          } else {
            var explicitClosingTag = "</" + child.tagName.toLowerCase() + ">";
            var explicitClosingTagAndOpeningTagEnd = ">" + explicitClosingTag;
            if (
              assignedString
                .substr(
                  getCharOffsetInAssignedHTML(),
                  explicitClosingTagAndOpeningTagEnd.length
                )
                .toLowerCase() === explicitClosingTagAndOpeningTagEnd
            ) {
              // something like <div></div>
              // this char will not show up in the re-serialized innerHTML
              charsAddedInSerializedHtml -= explicitClosingTag.length;
            }
          }
        }
        addElOrigin(child, "openingTagEnd", {
          action: actionName,
          trackingValue: assignedInnerHTML[1],
          inputValuesCharacterIndex: [charOffsetInSerializedHtml],
          value: serializedHtml,
          extraCharsAdded: charsAddedInSerializedHtml,
          error: error
        });
        charOffsetInSerializedHtml += openingTagEnd.length;
        forDebuggingProcessedHtml += openingTagEnd;

        if (child.tagName === "IFRAME") {
          forDebuggingProcessedHtml += child.outerHTML;
          charOffsetInSerializedHtml += child.outerHTML.length;
        } else {
          processNewInnerHtml(child);
        }

        if (tagTypeHasClosingTag(child.tagName)) {
          addElOrigin(child, "closingTag", {
            action: actionName,
            trackingValue: assignedInnerHTML[1],
            inputValuesCharacterIndex: [charOffsetInSerializedHtml],
            value: serializedHtml,
            extraCharsAdded: charsAddedInSerializedHtml,
            error: error
          });
          var closingTag = "</" + child.tagName + ">";
          charOffsetInSerializedHtml += closingTag.length;
          forDebuggingProcessedHtml += closingTag;

          let hasClosingTagButNotInAssignedHtml =
            assignedString.substr(
              getCharOffsetInAssignedHTML() - ">".length - closingTag.length,
              2
            ) === "/>";
          if (hasClosingTagButNotInAssignedHtml) {
            console.log("hasClosingTagButNotInAssignedHtml");
            // I don't really understand the +1, but it's needed
            charsAddedInSerializedHtml += closingTag.length - "/>".length + 1;
          }
        }
      } else {
        throw "not handled";
      }
      // consoleLog("processed", forDebuggingProcessedHtml, assignedInnerHTML.toString().toLowerCase().replace(/\"/g, "'") === forDebuggingProcessedHtml.toLowerCase())
    });
  }
}
