"use strict";

// Avoid creating variables in global scope. Put our object in the outer scope
// via the function argument instead.
(function (exports) {

  var { AppConstants } = ChromeUtils.import("resource://gre/modules/AppConstants.jsm");
  var { ExtensionCommon } = ChromeUtils.import("resource://gre/modules/ExtensionCommon.jsm");
  var { ExtensionSupport } = ChromeUtils.import("resource:///modules/ExtensionSupport.jsm");
  var { MailServices } = ChromeUtils.import("resource:///modules/MailServices.jsm");
  var { MsgHdrToMimeMessage } = ChromeUtils.import("resource:///modules/gloda/MimeMessage.jsm");
  var { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");

  class ColumnHandler {
    constructor(win, parseTree, options) {
      this.win = win;
      this.parseTree = parseTree;
      this.options = options;
      // defaults
      this.options.sortNumeric ??= false;
      this.options.useDBHeaders ??= false;
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
      return !this.options.sortNumeric;
    }

    // Required functions inherited from nsITreeView
    getRowProperties(index) { return ""; }
    getCellProperties(row, col) { return ""; }
    getImageSrc(row, col) { return ""; }
    getCellText(row, col) {
      if (this.isDummy(row)) {
        return "";
      } else {
        return this.getText(this.win.gDBView.getMsgHdrAt(row));
      }
    }
    cycleCell(row, col) { return; }
    isEditable(row, col) { return false; }

    // Local functions, not called by Thunderbird
    isDummy(row) {
      const MSG_VIEW_FLAG_DUMMY = 0x20000000; // from DBViewWrapper.jsm
      return (this.win.gDBView.getFlagsAt(row) & MSG_VIEW_FLAG_DUMMY) != 0;
    }
    getText(aHdr) {
      if (this.options.useDBHeaders) {
        return this.parse(this.parseTree, aHdr);
      } else {
        let headers = headerCache.getHeaders(aHdr, this.win); // null == pending
        return headers ? this.parse(this.parseTree, headers) : "";
      }
    }
    parse(node, headerSource) {
      // Recursively parse the tree to create the column content.
      switch (node.nodeType) {
        case "literal":
          return node.literalString;
        case "header":
          if (this.options.useDBHeaders) {
            // headerSource == aHdr
            // getStringProperty returns "" if the property is unavailable.
            return headerSource.getStringProperty(node.headerName.toLowerCase());
          } else {
            // headerSource == object of arrays of header content
            // at() instead of [] allows -1 => last
            return headerSource[node.headerName.toLowerCase()]?.at(node.headerIndex ?? 0) ?? "";
          }
        case "replace":
          if (node.replaceAll) {
            return this.parse(node.child, headerSource).replaceAll(node.target, node.replacement);
          } else {
            return this.parse(node.child, headerSource).replace(node.target, node.replacement);
          }
        case "regex":
          let re = new RegExp(node.pattern, node.flags); // potential errors
          return this.parse(node.child, headerSource).replace(re, node.replacement);
        case "concat":
          return node.children.map((child) => this.parse(child, headerSource)).join('');
        case "first":
          for (const child of node.children) {
            let childResult = this.parse(child, headerSource);
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

  class HeaderCache {
    constructor() {
      this.cache = new Map();
      this.timeouts = new Map();
    }

    getHeaders(aHdr, win) {
      if (!this.cache.has(aHdr)) {
        this.cache.set(aHdr, null); // null = pending
        this.loadHeaders(aHdr, win); // asynchronous call
      }
      return this.cache.get(aHdr);
    }

    async loadHeaders(aHdr, win) {
      let msg = await this.getMimeMessage(aHdr);
      let headers = this.convertMimeHeaders(msg);
      this.cache.set(aHdr, headers ?? {});
      // TODO separate view refreshing from header cache
      // Don't update the view right away because these requests come in bursts.
      // User interaction (such as mousing over or scrolling the view) will also
      // cause updates, so this delay is typically invisible.
      win.clearTimeout(this.timeouts.get(win));
      this.timeouts.set(win, win.setTimeout(function() {
        // If at least one message in the given range is visible, then custom
        // column values for all visible rows will be updated irrespective of
        // the actual specified range.
        // The range is automatically trimmed to visible rows, so just specify
        // the whole thing to make sure we include something visible. Not sure
        // how I'd find out which rows are visible on my own anyway.
        // nsMsgViewNotificationCode::changed == 2
        win.gDBView.NoteChange(0, win.gDBView.numMsgsInView - 1, 2);
      }, 100));
    }

    // https://searchfox.org/comm-central/source/mail/components/extensions/parent/ext-messages.js
    // getMimeMessage(msgHdr)
    async getMimeMessage(msgHdr) {
      // TODO NNTP messages not supported by MsgHdrToMimeMessage.
      // Use MsgHdrToRawMessage, as in messages API (link above).
      return await new Promise(resolve => {
        MsgHdrToMimeMessage(
          msgHdr,
          null,
          (_msgHdr, mimeMsg) => {
            resolve(mimeMsg);
          },
          true, // aAllowDownload
          {
            // only need headers
            "saneBodySize": true,
            "partsOnDemand": true,
            "examineEncryptedParts": false
          }
        );
      });
    }

    // https://searchfox.org/comm-central/source/mail/components/extensions/parent/ext-messages.js
    // convertMessagePart(part)
    convertMimeHeaders(part) {
      let convertedHeaders = {};
      if ("headers" in part) {
        for (let header of Object.keys(part.headers)) {
          convertedHeaders[header] = part.headers[header].map(h =>
            MailServices.mimeConverter.decodeMimeHeader(
              h,
              null, // aDefaultCharset
              false, // aOverride (charset)
              true // aUnfold (line continuations)
            )
          );
        }
      }
      return convertedHeaders;
    }
  }

  class ColumnManager {
    constructor(extension) {
      this.extension = extension;
      this.managedColumns = new Map();
      this.managedWindows = new Map();
    }

    get instanceId() {
      return `${this.extension.uuid}-${this.extension.instanceId}`;
    }

    get windowListenerId() {
      return `header-columns-${this.instanceId}`;
    }

    // Set up elements (and possibly handlers) for all columns in a new window.
    onLoadWindow(win) {
      if (win.document.documentElement.getAttribute("windowtype") != "mail:3pane")
        return;

      this.managedWindows.set(win, {
        "handlers": new Set(),
        "elements": new Set()
      });

      // Handlers are usually added by the MsgCreateDBView observer, but
      // we may have missed the event and need to do it ourselves.
      if (win.gDBView) {
        for (const id of this.managedColumns.keys()) {
          this.addHandler(win, id);
        }
      }

      for (const id of this.managedColumns.keys()) {
        this.addTreeCol(win, id);
      }
    }

    // Set up handlers for all columns in some window's new DBView.
    onCreateDBView() {
      for (const win of this.managedWindows.keys()) {
        for (const id of this.managedColumns.keys()) {
          this.addHandler(win, id);
        }
      }
    }

    // Clean up handlers and elements for all columns in a window.
    onUnloadWindow(win) {
      this.managedWindows.delete(win);
      // Handlers and elements are going away anyway, no need to remove.
    }

    // Add handlers and elements for a column to all windows.
    onRegisterColumn(id, label, tooltip, parseTree, options) {
      this.managedColumns.set(id, {
        "label": label,
        "tooltip": tooltip,
        "parseTree": parseTree,
        "options": options
      });
      for (const win of this.managedWindows.keys()) {
        this.addHandler(win, id);
        this.addTreeCol(win, id);
      }
    }

    // Remove handlers and elements for a column from all windows.
    onUnregisterColumn(id) {
      this.managedColumns.delete(id);
      for (const win of this.managedWindows.keys()) {
        this.removeHandler(win, id);
        this.removeTreeCol(win, id);
      }
    }

    // Add a column handler to a given window's DBView to be used by message
    // tree elements. Can be used to replace existing custom handlers.
    addHandler(win, id) {
      // If there's no gDBView, we can't do anything in this window yet. Wait
      // to get called again by the MsgCreateDBView observer.
      if (!win.gDBView) return;

      const col = this.managedColumns.get(id);
      if (!col) return;

      try {
        // We need a new instance of the handler for each window, because
        // each one needs a window reference to access message data.
        let handler = new ColumnHandler(win, col.parseTree, col.options);
        win.gDBView.addColumnHandler(id, handler);
      } catch (ex) {
        console.error(ex);
        throw new Error(`Cannot add column handler for column ID ${id}`);
      }
      this.managedWindows.get(win).handlers.add(id);
    }

    // Remove a column handler from a given window's DBView.
    removeHandler(win, id) {
      if (!win.gDBView) return;
      if (!this.managedWindows.get(win).handlers.has(id)) return;

      try {
        win.gDBView.removeColumnHandler(id);
      } catch (ex) {
        console.error(ex);
        throw new Error(`Cannot remove column handler for column ID ${id}`);
      }
      this.managedWindows.get(win).handlers.delete(id);
    }

    // Add a column element to a given window's message tree view. Can be used
    // to replace existing custom columns.
    addTreeCol(win, id) {
      // remove an old column if it already exists
      this.removeTreeCol(win, id);

      const col = this.managedColumns.get(id);
      if (!col) return;

      // create element
      const treeCol = win.document.createXULElement("treecol");
      treeCol.setAttribute("id", id);
      treeCol.setAttribute("persist", "hidden ordinal sortDirection width");
      treeCol.setAttribute("flex", "2");
      treeCol.setAttribute("closemenu", "none");
      treeCol.setAttribute("label", col.label);
      treeCol.setAttribute("tooltiptext", col.tooltip);

      // add element
      const threadCols = win.document.getElementById("threadCols");
      threadCols.appendChild(treeCol);

      // Restore persisted attributes.
      const attributes = Services.xulStore.getAttributeEnumerator(
        win.document.URL,
        id
      );
      for (const attribute of attributes) {
        const value = Services.xulStore.getValue(win.document.URL, id, attribute);
        // See Thunderbird bug 1607575 and bug 1612055.
        if (attribute != "ordinal" || parseInt(AppConstants.MOZ_APP_VERSION, 10) < 74) {
          treeCol.setAttribute(attribute, value);
        } else {
          treeCol.ordinal = value;
        }
      }

      this.managedWindows.get(win).elements.add(id);
    }

    // Remove a column element from a given window's message tree view.
    removeTreeCol(win, id) {
      if (!this.managedWindows.get(win).elements.has(id)) return;

      const treeCol = win.document.getElementById(id);
      if (!treeCol) return;

      treeCol.remove();
      this.managedWindows.get(win).elements.delete(id);
    }

    // Remove all handlers and elements from all managed windows.
    removeAll() {
      for (const [win, state] of this.managedWindows) {
        for (const id of state.handlers) {
          this.removeHandler(win, id);
        }
        for (const id of state.elements) {
          this.removeTreeCol(win, id);
        }
      }
      this.managedWindows.clear();
    }
  }

  var manager;
  var headerCache;

  var createDBViewObserver = {
    observe(aMsgFolder, aTopic, aData) {
      manager.onCreateDBView();
    },
    register() {
      Services.obs.addObserver(this, "MsgCreateDBView", false);
    },
    unregister() {
      Services.obs.removeObserver(this, "MsgCreateDBView");
    }
  };

  class HeaderColumns extends ExtensionCommon.ExtensionAPI {
    // Construct an instance of our experiment; called once (per addon using the
    // experiment) upon first experiment use, independent of calling contexts.
    // The corresponding instance cleanup function is onShutdown().
    constructor(...args) {
      // Note: super() sets our this.extension member to the extension.
      super(...args);

      manager = new ColumnManager(this.extension);
      headerCache = new HeaderCache();

      createDBViewObserver.register();

      ExtensionSupport.registerWindowListener(
        manager.windowListenerId,
        {
          chromeURLs: [
            "chrome://messenger/content/messenger.xul",
            "chrome://messenger/content/messenger.xhtml"
          ],
          onLoadWindow(win) {
            manager.onLoadWindow(win);
          },
          onUnloadWindow(win) {
            manager.onUnloadWindow(win);
          }
        }
      );
    }

    // Clean up this instance of the experiment.
    // Counterpart to the constructor.
    onShutdown(isAppShutdown) {
      if (isAppShutdown) return; // Everything is going away anyway.

      ExtensionSupport.unregisterWindowListener(manager.windowListenerId);
      createDBViewObserver.unregister();
      manager.removeAll();

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
          registerColumn(id, label, tooltip, parseTree, options) {
            manager.onRegisterColumn(...arguments);
          },
          unregisterColumn(id) {
            manager.onUnregisterColumn(id);
          }
        }
      };
    }
  }

  exports.HeaderColumns = HeaderColumns;
})(this);
