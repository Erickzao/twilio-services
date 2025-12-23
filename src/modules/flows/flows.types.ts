// ============================================
// Tipos do Modelo Simplificado (Input do Usuário)
// ============================================

export type FlowNodeType = 'message' | 'question' | 'buttons' | 'transfer';
export type FlowStatus = 'draft' | 'published' | 'error';

export interface Position {
  x: number;
  y: number;
}

export interface FlowButton {
  id: string;
  label: string;
  value: string;
  nextNodeId: string;
}

export interface TransferConfig {
  workflowSid?: string;
  channelSid?: string;
  priority?: number;
  timeout?: number;
  attributes?: Record<string, string>;
}

export interface FlowNode {
  id: string;
  type: FlowNodeType;
  position: Position;
  content: string;
  buttons?: FlowButton[];
  nextNodeId?: string;
  transferConfig?: TransferConfig;
  timeout?: number;
  contentTemplateSid?: string; // HX SID para Content Templates (botões interativos)
}

export interface FlowInput {
  name: string;
  description?: string;
  nodes: FlowNode[];
  startNodeId: string;
}

export interface FlowUpdateInput {
  name?: string;
  description?: string;
  nodes?: FlowNode[];
  startNodeId?: string;
}

// ============================================
// Tipos do Modelo Persistido (Database)
// ============================================

export interface Flow {
  id: string;
  name: string;
  description?: string;
  nodes: FlowNode[];
  start_node_id: string;
  twilio_flow_sid?: string;
  status: FlowStatus;
  error_message?: string;
  created_at: Date;
  updated_at: Date;
  published_at?: Date;
}

// ============================================
// Tipos do Twilio Studio (Output do Builder)
// ============================================

export interface TwilioOffset {
  x: number;
  y: number;
}

export interface TwilioTransition {
  event: string;
  next?: string;
  conditions?: TwilioCondition[];
}

export interface TwilioCondition {
  type: string;
  friendly_name: string;
  value: string;
  arguments: string[];
}

export interface TwilioWidgetProperties {
  offset: TwilioOffset;
  [key: string]: unknown;
}

export interface TwilioWidget {
  name: string;
  type: string;
  properties: TwilioWidgetProperties;
  transitions: TwilioTransition[];
}

export interface TwilioFlowDefinition {
  description: string;
  flags: {
    allow_concurrent_calls: boolean;
  };
  initial_state: string;
  states: TwilioWidget[];
}

// ============================================
// Tipos de Resposta da API
// ============================================

export interface FlowPreview {
  flow: Flow;
  twilioDefinition: TwilioFlowDefinition;
}

export interface FlowPublishResult {
  success: boolean;
  twilioFlowSid?: string;
  error?: string;
}
