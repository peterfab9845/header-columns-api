# HeaderColumns Experiment API

The HeaderColumns experiment API allows customized columns to be added to the mailbox tree view.
The content of these columns is produced based on user-configured headers with processing.

## Installation

Include the repository within your extension's `api` folder, and add the following snippet to the `experiment_apis` section of your extension manifest:

```json
"HeaderColumns": {
  "schema": "api/header-columns-api/schema.json",
  "parent": {
    "scopes": ["addon_parent"],
    "paths": [["HeaderColumns"]],
    "script": "api/header-columns-api/implementation.js"
  }
}
```

## Usage

### API Functions

The following functions are provided:

**registerColumn(id, label, tooltip, parseTree, options)**

Adds or replaces a column with the given column label and tooltip.
Content is determined by the provided parse tree and options (described below).

**unregisterColumn(id)**

Removes the column with the given ID.
It is not necessary to unregister a column before registering a replacement with the same ID.

### Parsing Tree

The parse tree is a structure composed of nodes of the types listed below.
Each node's type is designated by its `nodeType` property.

- `header`
    - Returns message header content
    - Properties:
        - `headerName` - Name of header
        - `headerIndex` (optional, default 0) - Which occurrence of a repeated header to take
            - 0 = first occurrence, 1 = second, etc. Negatives wrap around (-1 = last occurrence, -2 = second-last, etc.)
            - Has no effect if the `useDBHeaders` option is true. Behavior with repeated headers depends on TB version and has special cases.
- `literal`
    - Returns literal string
    - Properties:
        - `literalString` - String to return
- `replace`
    - Returns result of replace() or replaceAll() on child
    - Properties:
        - `target` - Target substring
        - `replacement` - Replacement substring
        - `replaceAll` - True if replaceAll should be used
        - `child` - The tree node to use as input
- `regex`
    - Returns result of replace() on child with RegExp
    - Properties:
        - `pattern` - Target regex pattern string
        - `flags` - Target regex flags string
        - `replacement` - Replacement substring
        - `child` - The tree node to use as input
- `concat`
    - Returns concatenation of all child elements
    - Properties:
        - `children` - Array of tree nodes to concatenate (1 or more)
- `first`
    - Returns first non-empty child element
    - Properties:
        - `children` - Array of tree nodes to try (1 or more)

Invalid parse trees will not be accepted by the API, due to verification against `schema.json`.

### Options

The options object defines various configurations for the column, via the properties listed below.

- `sortNumeric` (optional, default false) - If true, the column will be sorted by the numeric value of the final content; otherwise, it will be sorted alphanumerically.
- `useDBHeaders` (optional, default false) - If true, only headers which are pre-parsed into the DB will be available. This provides a significant performance improvement, but has several important caveats (see below).

### The `customDBHeaders` Preference

In order for the content of a non-default header to be parsed and recorded in the mail database by Thunderbird, allowing it to be used with `useDBHeaders` set, that header must be listed in the space-separated preference `mailnews.customDBHeaders` at the time the message is downloaded.

If needed, new headers can be added to existing messages by running a repair operation on their containing folder (Folder Properties > Repair Folder).
Note that this process may reset the folder's column layout and sort order.

The default message properties accessible without setting `customDBHeaders` are likely TB version-dependent, and are typically not MIME-decoded.
Some possibly useful properties which may exist are:

- `subject` - message subject
- `sender` - sender name and address
- `sender_name` - sender name with some numeric prefix
- `recipients` - comma-separated To recipient names and addresses
- `recipient_names` - comma-separated To recipient names with some numeric prefix
- `ccList` - comma-separated CC list
- `replyTo` - reply-to name and address
- `priority` - integer 1-6, 1 = none defined, 2-6 = low-high
- `flags` - message flags (read, star, etc.), possibly in hex
- `keywords` - space-separated message keywords, including the colorable tags
- `message-id` - message id string
- `msgCharSet` - message charset
- `numLines` - total message lines with headers, in hex

NOTE: This Experiment API does not manage the `customDBHeaders` preference, and cannot make any guarantees regarding the default properties listed above.

## Examples

### Column Registration

```javascript
messenger.HeaderColumns.registerColumn(
  "fromDomainColumn",
  "From domain",
  "Sort by from domain",
  {
    "nodeType": "concat",
    "children": [
      {
        "nodeType": "literal",
        "literalString": "Domain is "
      },
      {
        "nodeType": "regex",
        "pattern": ".*@([^>]*)>?$",
        "replacement": "$1",
        "flags": "",
        "child": {
          "nodeType": "header",
          "headerName": "From",
        }
      }
    ]
  },
  {
    "sortNumeric": false,
    "useDBHeaders": false
  }
);
```

### Full Add-ons

* [X-Original-To Column](https://github.com/peterfab9845/original-to-column): Simple add-on adding a column with the content of the X-Original-To header.
* [Header Columns](https://github.com/peterfab9845/tb-header-columns): More advanced add-on allowing users to create their own custom columns.

## Credits

* [Full address column](https://github.com/lkosson/full-address-column/) by Łukasz Kosson
* [Sender Frequency](https://addons.thunderbird.net/en-us/thunderbird/addon/sender-frequency/) by Jörg Knobloch
* [LegacyCSS](https://github.com/thundernest/addon-developer-support/tree/master/auxiliary-apis/LegacyCSS) by John Bieling

