/**
 * Arkiv 1.x schema for every haven.board.* and haven.*.full entity this
 * protocol writes. One untagged schema covers all groups: readers select
 * attributes by name and tolerate missing columns, and writers only ever
 * set the columns their record kind uses. `payload` carries the JSON body;
 * there is no `$payload`/`$contentType` field in 1.x — both are attributes.
 */
import { bytes, defineSchema, i32, str, u256 } from '@arkiv-network/sdk/schema'
import type { Schema } from '@arkiv-network/sdk/schema'

export const BOARD_SCHEMA: Schema = defineSchema({
  grp: str().indexed(),
  board: str().indexed().optional(),
  subject: str().optional(),
  title: str().optional(),
  about: str().optional(),
  gate_type: i32().optional(),
  gate_token: str().optional(),
  gate_chain: i32().optional(),
  gate_threshold: u256().optional(),
  mime: i32().optional(),
  sealed: i32().optional(),
  sha256_ct: str().indexed().optional(),
  root_ref: str().optional(),
  parent_ref: str().optional(),
  no_bump: i32().optional(),
  bump_limit: i32().optional(),
  capacity: i32().optional(),
  page_size: i32().optional(),
  content_type: str(),
  payload: bytes(),
  // haven.*.full media fields (title, size, piece/fcid live in the JSON payload;
  // only the indexed/queryable attributes need columns here)
  dur_s: i32().optional(),
  drip_id: str().indexed().optional(),
  drip_total: i32().optional(),
  drip_idx: i32().optional(),
  series_ref: str().indexed().optional(),
  mcap_usd: i32().optional(),
})
