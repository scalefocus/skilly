// @fontsource-variable/* are CSS-only packages (side-effect imports) with no type declarations.
// TypeScript 6 errors on untyped side-effect imports (TS2882); declare them as opaque modules.
declare module "@fontsource-variable/*";
