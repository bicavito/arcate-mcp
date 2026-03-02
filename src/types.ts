/**
 * Arcate MCP Server — Shared Types
 * Mirrors the Supabase schema and frontend types.js definitions.
 */

// ─── Auth ────────────────────────────────────────────────────────────────────

export interface AuthContext {
    valid: boolean;
    organizationId: string;
    userId: string;
    scopes: string[];
}

// ─── Signal ───────────────────────────────────────────────────────────────────

export const SIGNAL_TYPES = ['mention', 'friction', 'problem', 'deal-loss'] as const;
export type SignalType = typeof SIGNAL_TYPES[number];

export const SIGNAL_CATEGORIES = ['feature', 'workflow'] as const;
export type SignalCategory = typeof SIGNAL_CATEGORIES[number];

export const SIGNAL_SEVERITIES = ['Low', 'Medium', 'High'] as const;
export type SignalSeverity = typeof SIGNAL_SEVERITIES[number];

export const SIGNAL_SOURCES = [
    'Slack', 'Intercom', 'E-Mail', 'Support ticket', 'Sales call', 'User interview'
] as const;
export type SignalSource = typeof SIGNAL_SOURCES[number];

export interface Signal {
    id: string;
    readable_id: string;
    summary: string;
    description?: string;
    type: SignalType;
    category: SignalCategory;
    severity: SignalSeverity;
    source?: SignalSource | string;
    status: string;
    account_id?: string;
    linked_initiative_id?: string;
    organization_id: string;
    created_by: string;
    created_at: string;
    ingestion_source?: 'web' | 'mcp' | 'intercom_sync' | 'api' | 'bulk_import';
    raw_payload?: Record<string, unknown>;
}

export interface CreateSignalInput {
    summary: string;
    description?: string;
    type: SignalType;
    category: SignalCategory;
    severity: SignalSeverity;
    source?: string;
    account_id?: string;
}

// ─── Initiative ───────────────────────────────────────────────────────────────

export const INITIATIVE_STATES = [
    'New', 'Triaged', 'Active', 'Measuring', 'Validated', 'Kill'
] as const;
export type InitiativeState = typeof INITIATIVE_STATES[number];

export const STANDARD_HEALTH_METRICS = [
    'Retention Rate', 'Time to Value', 'Activation Rate',
    'Adoption Rate', 'Expansion Rate', 'Churn Rate'
] as const;

export type MetricType = 'percentage' | 'ratio' | 'currency' | 'duration' | 'number';

export interface HealthMetricValue {
    value: number;
    type: MetricType;
}

export interface Initiative {
    id: string;
    readable_id: string;
    title: string;
    brief?: string;
    state: InitiativeState;
    target_outcome?: {
        metric: string;
        target_value: number;
        timeframe: string;
    };
    health_metrics?: Record<string, HealthMetricValue | number>;
    organization_id: string;
    created_by: string;
    created_at: string;
}

export interface EnrichInitiativeInput {
    initiative_id: string;
    additional_signal_ids?: string[];
    refined_hypothesis?: string;
    target_outcome?: {
        metric: string;
        target_value: number;
        timeframe: string;
    };
    health_metrics?: Record<string, HealthMetricValue | number>;
    start_date?: string;
    target_date?: string;
}

export interface CreateInitiativeInput {
    title: string;
    brief?: string;
    signal_ids?: string[];
}

// ─── Customer ─────────────────────────────────────────────────────────────────

export const CUSTOMER_TIERS = ['Free', 'Standard', 'Premium', 'Enterprise'] as const;
export type CustomerTier = typeof CUSTOMER_TIERS[number];

export interface Customer {
    id: string;
    name: string;
    website?: string;
    tier?: CustomerTier;
    arr?: number;
    health_score?: number;
    status?: string;
    organization_id: string;
    created_at: string;
}

export interface CreateCustomerInput {
    name: string;
    website?: string;
    tier?: CustomerTier;
    arr?: number;
}

// ─── MCP Errors ───────────────────────────────────────────────────────────────

export class ArcateMCPError extends Error {
    constructor(message: string) {
        super(`Arcate MCP: ${message}`);
        this.name = 'ArcateMCPError';
    }
}
