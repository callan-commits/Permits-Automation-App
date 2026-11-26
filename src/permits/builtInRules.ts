/**
 * The permit cheat sheet, built into the app (from Permit_Automation_Cheat_Sheet.xlsx, Nov 2026).
 * A permit is required when the work area is within the distance (horizontally, inclusive) of any
 * asset of the owner. "A/B" lists alternative names for one owner.
 * To change a rule for everyone, edit this list; changes made in the app stay in that browser only.
 */
export const BUILT_IN_RULES: ReadonlyArray<{ owner: string; distance: number; permit: string }> = [
  { owner: 'MTM/Metro Trains Melbourne', distance: 2, permit: 'NAE' },
  { owner: 'VicTrack', distance: 5, permit: 'PTW' },
  { owner: 'Jemena', distance: 6.4, permit: 'VESI' },
  { owner: 'Zinfra', distance: 6.4, permit: 'VESI' },
  { owner: 'Melbourne Water', distance: 5, permit: 'PTW' },
];
