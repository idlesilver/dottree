# dottree

Maintain directory-tree text with automatic prefixes, colors, and folding.

## Features

- Maintain tree prefixes while indenting/outdenting (Tab/Shift+Tab).
- Insert a sibling line with Enter.
- Snippet: type `|` to insert a starter tree.
- Highlight prefixes, folders, and files (folders are orange + bold; files white).
- `#` comments supported (uses theme comment color).
- Folding for subtrees (triangle gutter, like code folding).
- Works in `.tree` files and in Markdown code fences (`tree`).

## Quick Start

1. Create a file with the `.tree` extension, or set language mode to `Tree`.
2. Type or paste a tree, then use Tab/Shift+Tab to adjust structure.
3. Use Enter to add a sibling line.
4. Type `|` on an empty line and accept the snippet to insert:

```
./
└─ README.md
```

## Example

```
project_root/
├─ src
│  └─ app/
│     ├─ core/
│     └─ ui/
└─ README.md # note
```

## Markdown Support

Use fenced code blocks with language `tree`:

````markdown
```tree
├─ src/
│  └─ app/
└─ README.md
```
````

## Commands

- `Dot Tree: Indent (maintain prefixes)`
- `Dot Tree: Outdent (maintain prefixes)`
- `Dot Tree: New Line (same level)`

## Keybindings

- `Tab` / `Shift+Tab`: indent/outdent on tree lines
- `Enter`: insert sibling line on tree lines

## Configuration

- `dottree.style`: `unicode` or `ascii` (default `unicode`)
- `dottree.indentSubtreeOnSingleCursor`: indent/outdent subtree on single cursor (default `true`)

## License

MIT
