/** Mark III–inspired titanium-gold alloy palette */
export const COLORS = {
  // Candy-apple armor red (film-adjacent, not flat)
  red: 0xa50f18,
  redDeep: 0x5c0a10,
  redHighlight: 0xd4202c,
  // Gold alloy trim
  gold: 0xd4a82a,
  goldBright: 0xf0c94a,
  goldDeep: 0x8a6a18,
  // Under-suit / joint carbon-titanium
  dark: 0x121216,
  darkMetal: 0x1e1e24,
  core: 0x0a0a0e,
  // Arc reactor / HUD
  reactor: 0x6ee7ff,
  reactorCore: 0xe8fcff,
  eye: 0xfff3b0,
  /**
   * Cool hangar void — shared by scene.background, FogExp2, CSS --bg,
   * and the WebGL clear color so loader → canvas never flashes a mismatch.
   */
  fog: 0x070b14,
  bg: 0x070b14,
} as const;
