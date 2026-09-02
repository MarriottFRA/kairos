/**
 * Copy hotel setup — shared types + IPC channel names.
 *
 * A cluster sets up ONE hotel's cost architecture and then needs the same
 * blocks, schemes and columns at its sibling properties. This surface copies a
 * hotel's whole OU-wide setup — blocks (recompiled against the target),
 * NI/SS schemes, KPI drivers, allocations, the field catalog, the budget
 * calendar and position defaults — from another hotel that exists in the LOCAL
 * store. Positions are deliberately not part of it: they are scenario-scoped
 * people, not setup.
 *
 * The request names two hotels. `ou` is always the TARGET (the currently
 * selected hotel, which the OU gate validates); `sourceOu` is re-validated in
 * the handler, the same pattern the cluster channels use.
 */

/** A hotel that can be copied from: it has live blocks in the local store. */
export interface HotelCopySourceDto {
  ou: string;
  /** Live (non-deleted) blocks the hotel has locally. */
  blockCount: number;
}

export interface HotelCopySourcesResponse {
  sources: HotelCopySourceDto[];
}

export interface HotelCopySetupRequest {
  /** Target: the currently selected hotel. */
  ou: string;
  /** Source: the hotel whose setup is copied. */
  sourceOu: string;
}

/** What landed, for the confirmation toast. */
export interface HotelCopySetupResponse {
  blocks: number;
  ssSchemes: number;
  kpiDrivers: number;
  allocations: number;
  /** USER-origin field-catalog columns (system-column tweaks travel silently). */
  customFields: number;
  /** Calendar years copied — years the target had already set up are kept. */
  calendarYears: number;
}

export const HOTEL_COPY_CHANNELS = {
  /** Hotels with local blocks the current hotel could copy from. */
  listSources: "hotelCopy:list-sources",
  /** Copy the source hotel's whole setup into the (block-less) target. */
  copySetup: "hotelCopy:copy-setup",
} as const;
