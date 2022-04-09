# HeaderColumns Experiment API

The HeaderColumns experiment API allows customized columns to be added to the mailbox tree view.
The content of these columns is produced based on user-configured headers with processing.

## Installation

Copy the `api/HeaderColumns` directory to your extension, and add the following snippet to the `experiment_apis` section of your extension manifest:

```json
"HeaderColumns": {
  "schema": "api/HeaderColumns/schema.json",
  "parent": {
    "scopes": ["addon_parent"],
    "paths": [["HeaderColumns"]],
    "script": "api/HeaderColumns/implementation.js",
    "events": ["startup"]
  }
}
```

## Usage

### API Functions

The following functions are provided:

**registerColumn(id, label, tooltip, parseTree, sortNumeric)**

Adds or replaces a column with the given column label and tooltip.
Content is determined by the provided parse tree (described below).
If `sortNumeric` is true, the column will be sorted based on the numeric value of the final content; otherwise, it will be sorted alphanumerically.

**unregisterColumn(id)**

Removes the column with the given ID.
It is not necessary to unregister a column before registering a replacement with the same ID.

**addWindowListener()**

Adds a window listener to manipulate the tree view.
Should only be called once.
Recommended to call when your extension starts, but may be called at any point before or after registering columns.

### Parsing Tree

The parse tree is a structure composed of nodes of the types listed below.
Each node's type is designated by its `nodeType` property.

- `header`
    - Returns raw header content
    - Properties:
        - `headerName` - Name of header
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

Example:

```json
{
  "nodeType": "concat",
  "children": [
    {
      "nodeType": "literal",
      "literalString": "Hello "
    },
    {
      "nodeType": "regex",
      "target": " <.*>$",
      "replacement": "",
      "flags": "",
      "child": {
        "nodeType": "header",
        "headerName": "To"
      }
    }
  ]
}
```

### The `customDBHeaders` Preference

In order for the content of a particular header to be present in the mail database, that header must be present in the space-separated preference `mailnews.customDBHeaders` at the time the message is downloaded.
If needed, the database for a folder can be rebuilt by selecting Folder Properties > Repair Folder.
Note that this process may reset its column layout and sort order.

This API does not manage this preference; for this purpose, it is currently recommended to use the [LegacyPrefs](https://github.com/thundernest/addon-developer-support/tree/master/auxiliary-apis/LegacyPrefs) experiment API.

## Credits

This API is based on the source of [Full address column](https://github.com/lkosson/full-address-column/) by Łukasz Kosson, which in turn is based on [Sender Frequency](https://addons.thunderbird.net/en-us/thunderbird/addon/sender-frequency/) by Jörg Knobloch.

