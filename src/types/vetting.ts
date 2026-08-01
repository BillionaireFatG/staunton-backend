// ============================================================================
// Vetting domain types (Module 1) — mirror of the 013_vetting_core.sql schema.
// ============================================================================

export type OrgStatus =
  | 'draft'
  | 'pending'
  | 'provisional'
  | 'full'
  | 'suspended'
  | 'blacklisted'

export type Lane = 'invited' | 'applied'
export type Side = 'buy' | 'sell' | 'both'
export type KycStatus = 'pending' | 'verified' | 'failed'

export type CheckSubjectType =
  | 'org'
  | 'member'
  | 'owner'
  | 'listing'
  | 'document'
  | 'deal'

export type CheckStatus = 'pending' | 'pass' | 'fail' | 'flagged'

export type ScreeningOutcome =
  | 'pending'
  | 'no_match'
  | 'false_positive'
  | 'true_match'

// Phase-1 check types (verification_checks.check_type)
export type CheckType =
  | 'kyb_registry'
  | 'kyc_identity'
  | 'sanctions_screening'
  | 'pep_screening'
  | 'adverse_media'
  | 'video_interview'
  | 'beneficial_ownership'
  | 'principal_status'
  | 'trade_reference'
  | 'approval_decision'
  | 'blacklist_reentry'

export interface Organization {
  id: string
  legal_name: string
  trading_name?: string | null
  jurisdiction: string
  registry_number?: string | null
  entity_type?: string | null
  year_established?: number | null
  website?: string | null
  address?: Record<string, unknown> | null
  status: OrgStatus
  lane: Lane
  invited_by?: string | null
  invite_code_used?: string | null
  is_principal?: boolean | null
  commodities?: string[] | null
  sides?: Side[] | null
  typical_volume?: string | null
  typical_ticket?: string | null
  trade_history?: TradeHistory | null
  attestation?: Attestation | null
  created_at: string
  updated_at: string
}

export interface TradeReference {
  name: string
  company: string
  contact: string
}

export interface TradeHistory {
  corridors?: string
  years_active?: number
  references?: TradeReference[]
}

export interface Attestation {
  accepted: boolean
  authorized: boolean
  ip: string
  at: string
}

export interface Member {
  id: string
  org_id: string
  auth_user_id?: string | null
  email: string
  full_name: string
  role?: string | null
  is_signatory: boolean
  is_admin: boolean
  kyc_status: KycStatus
  created_at: string
}

export interface BeneficialOwner {
  id: string
  org_id: string
  full_name: string
  dob?: string | null
  nationality?: string | null
  ownership_pct?: number | null
  kyc_status: KycStatus
  pep_flag: boolean
  sanctions_flag: boolean
  screened_at?: string | null
  created_at: string
}

export interface VerificationCheck {
  id: string
  subject_type: CheckSubjectType
  subject_id: string
  check_type: string
  status: CheckStatus
  method?: string | null
  verified_by?: string | null
  verified_at?: string | null
  evidence_url?: string | null
  notes?: string | null
  created_at: string
}

export interface ApplicationDocument {
  id: string
  org_id: string
  doc_type: string
  file_path: string
  original_name?: string | null
  mime_type?: string | null
  size_bytes?: number | null
  uploaded_at: string
  review_status: 'pending' | 'accepted' | 'rejected'
  review_notes?: string | null
  reviewed_by?: string | null
}

export interface ScreeningResult {
  id: string
  subject_type: 'org' | 'owner'
  subject_id: string
  provider: string
  query_payload?: Record<string, unknown> | null
  raw_response?: Record<string, unknown> | null
  match_count?: number | null
  highest_score?: number | null
  reviewed_by?: string | null
  review_outcome?: ScreeningOutcome | null
  screened_at: string
}

export interface Invitation {
  id: string
  code: string
  issued_by?: string | null
  issued_to_email?: string | null
  issued_to_name?: string | null
  note?: string | null
  expires_at?: string | null
  redeemed_by?: string | null
  redeemed_at?: string | null
  revoked_at?: string | null
  created_at: string
}
