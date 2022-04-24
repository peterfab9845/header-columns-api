"use strict";

// Avoid creating variables in global scope. Put our object in the outer scope
// via the function argument instead.
(function (exports) {

  var { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
  var { ExtensionSupport } = ChromeUtils.import('resource:///modules/ExtensionSupport.jsm');

  class ColumnHandler {
    constructor(parseTree, sortNumeric) {
      this.parseTree = parseTree;
      this.sortNumeric = sortNumeric;
    }

    // Access to the window object
    init(win) {
      this.win = win;
    }

    // Required (?) custom column handler functions are according to
    // https://searchfox.org/comm-central/source/mailnews/base/public/nsIMsgCustomColumnHandler.idl
    // Not sure if the requirement is up to date on what actually gets called,
    // but it seems to work fine without some of the "required" ones anyway.

    // Required functions directly from nsIMsgCustomColumnHandler
    getSortStringForRow(aHdr) {
      return this.getText(aHdr);
    }
    getSortLongForRow(aHdr) {
      // Map float to long, preserving order. This takes advantage of the fact
      // that the binary value of least significant 31 bits of an IEEE-754 float
      // has an ordered correspondence with the absolute magnitude of the number.

      // First get the float value
      let val = parseFloat(this.getText(aHdr));

      // Sort non-numbers before numbers
      if (!isFinite(val)) {
        // 0 can only result from 0xffffffff, which corresponds to one of the
        // many possible representations of NaN. This one appears unused.
        return 0;
      }

      // Turn the float into a uint32 to allow bitwise operations.
      let view = new DataView(new ArrayBuffer(4));
      view.setFloat32(0, val);
      let bits = view.getUint32(0);

      // There are two problems we need to correct:
      // 1. Negatives sort in reverse order. (More-negative numbers have a higher
      //      unsigned binary value than less-negative numbers.)
      // 2. Negatives sort before positives. (Negatives start with a 1).
      //
      // To address #1, we can invert the non-sign bits if the number is negative.
      // This reverses the ordering within the negative range.
      // To address #2, we can invert the sign bit unconditionally. This swaps
      // the negatives and positives in the unsigned integer range.
      //
      // Here is how these two are accomplished:
      // First, arithmetic right-shift the value by 31 to produce 32 bits of 1s
      // for a negative number and 32 bits of 0s for a positive number. Then, OR
      // this with 0x80000000 to set the MSB to 1 unconditionally. Finally, XOR
      // the resulting mask with the original value to do #1 and #2 simultaneously.
      return bits ^ ((bits >> 31) | (1 << 31));
    }
    isString() {
      return !this.sortNumeric;
    }

    // Required functions inherited from nsITreeView
    getRowProperties(index) { return ""; }
    getCellProperties(row, col) { return ""; }
    getImageSrc(row, col) { return ""; }
    getCellText(row, col) {
      if (!this.isDummy(row)) {
        return this.getText(this.win.gDBView.getMsgHdrAt(row));
      } else {
        return "";
      }
    }
    cycleCell(row, col) {}
    isEditable(row, col) { return false; }

    // Local functions, not called by Thunderbird
    isDummy(row) {
      const MSG_VIEW_FLAG_DUMMY = 0x20000000; // from DBViewWrapper.jsm
      return (this.win.gDBView.getFlagsAt(row) & MSG_VIEW_FLAG_DUMMY) != 0;
    }
    getText(aHdr) {
      return this.parse(this.parseTree, aHdr);
    }
    parse(node, aHdr) {
      // Recursively parse the tree to create the column content.
      switch (node.nodeType) {
        case "literal":
          return node.literalString;
        case "header":
          // The desired headers must be stored in the message database, which is
          // controlled by mailnews.customDBHeaders preference.
          // getStringProperty returns "" if nothing is found.
          return aHdr.getStringProperty(node.headerName.toLowerCase());
        case "replace":
          if (node.replaceAll) {
            return this.parse(node.child, aHdr).replace(node.target, node.replacement);
          } else {
            return this.parse(node.child, aHdr).replaceAll(node.target, node.replacement);
          }
        case "regex":
          let re = new RegExp(node.pattern, node.flags); // potential errors
          return this.parse(node.child, aHdr).replace(re, node.replacement);
        case "concat":
          return node.children.map((child) => this.parse(child, aHdr)).join('');
        case "first":
          for (const child of node.children) {
            let childResult = this.parse(child, aHdr);
            if (childResult != "") {
              return childResult;
            }
          }
          return "";
        default:
          console.error(`HeaderColumns: Unsupported node type '${node.nodeType}'.`);
          return "";
      }
      return "";
    }
  }

  // List of columns managed by this instance of the experiment, passed
  // directly to the customcol js. To update a column, change it in the map
  // here and then notify customcols to reread the map.
  const managedColumns = new Map();

  class HeaderColumns extends ExtensionCommon.ExtensionAPI {
    // Construct an instance of our experiment; called once (per addon using the
    // experiment) upon first experiment use, independent of calling contexts.
    // The corresponding instance cleanup function is onShutdown().
    constructor(...args) {
      // Note: super() sets our this.extension member to the extension.
      super(...args);

      ExtensionSupport.registerWindowListener(
        `header-columns-${this.extension.uuid}-${this.extension.instanceId}`,
        {
          extension: this.extension, // TODO ugly, use a class containing the functions instead
          chromeURLs: [
            "chrome://messenger/content/messenger.xul",
            "chrome://messenger/content/messenger.xhtml"
          ],
          onLoadWindow: function(win) {
            // FIXME this setup all overwrites an existing CustomColumns object if multiple instances of the API exist
            // keep only one loaded somehow?
            win.CustomColumns = {};
            Services.scriptloader.loadSubScript(this.extension.getURL("api/header-columns-api/customcol.js"), win.CustomColumns);
            win.CustomColumns.managedColumns = managedColumns;
            win.CustomColumns.CustomColumnsView.init(win);
          },
          onUnloadWindow: function(win) {
            // FIXME this causes an error on window close if multiple instances of the API exist
            // how do we know whether to destroy or not?
            win.CustomColumns.CustomColumnsView.destroy();
            delete win.CustomColumns;
          }
        }
      );
    }

    // Using the startup event causes our experiment to be instantiated on
    // extension load instead of on first use.
    onStartup() {
      // TODO possibly remove this and startup event depending on chat response
      // don't actually care about startup, just using the startup event so that
      // the experiment gets loaded
    }

    // Clean up this instance of the experiment.
    // Counterpart to the constructor.
    onShutdown(isAppShutdown) {
      if (isAppShutdown) return; // Everything is going away anyway.

      ExtensionSupport.unregisterWindowListener(`header-columns-${this.extension.uuid}-${this.extension.instanceId}`);

      // TODO possibly remove depending on chat response
      // Looks like we got uninstalled. Maybe a new version will be installed now.
      // Due to new versions not taking effect (https://bugzilla.mozilla.org/show_bug.cgi?id=1634348)
      // we invalidate the startup cache. That's the same effect as starting with -purgecaches
      // (or deleting the startupCache directory from the profile).
      Services.obs.notifyObservers(null, "startupcache-invalidate");
    }

    // Create the API for a particular calling context. Could be called
    // multiple times in a single instance of the experiment.
    // Cleanup for each calling context is done using context.callOnClose().
    getAPI(context) {
      return {
        HeaderColumns: {
          registerColumn(id, label, tooltip, parseTree, sortNumeric) {
            let handler = new ColumnHandler(parseTree, sortNumeric);
            managedColumns.set(id, {
              "label": label,
              "tooltip": tooltip,
              "handler": handler
            });
            Services.obs.notifyObservers(null, "CustomColumns:column-updated", id);
          },
          unregisterColumn(id) {
            managedColumns.delete(id);
            Services.obs.notifyObservers(null, "CustomColumns:column-updated", id);
          }
        }
      };
    }
  }

  exports.HeaderColumns = HeaderColumns;
})(this);
