# Diagrams

Pre-rendered SVGs for the README and docs. Source (Mermaid) lives in
`src/`; themed output (GitHub light + dark) is committed alongside for
direct embedding via `<picture>`:

```html
<picture>
  <source media="(prefers-color-scheme: dark)"  srcset="assets/diagrams/X-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/diagrams/X-light.svg">
  <img src="assets/diagrams/X-light.svg">
</picture>
```

## Regenerate

```bash
# Install the renderer once (dev-only dep, not a runtime requirement)
npm install beautiful-mermaid    # in any directory

# Regenerate all SVGs in place
node assets/diagrams/build.mjs
```

`beautiful-mermaid` is [lukilabs/beautiful-mermaid](https://github.com/lukilabs/beautiful-mermaid)
— a synchronous Mermaid-to-SVG renderer with built-in GitHub-matching
themes. It's a dev dependency only; nothing in pi-evolver's runtime
depends on it.

## Edit

1. Edit the relevant `.mmd` source file in `src/`.
2. `node assets/diagrams/build.mjs` to regenerate.
3. Commit both the `.mmd` and the two SVGs.
