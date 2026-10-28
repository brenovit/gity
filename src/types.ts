export type Role = 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type Message =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError?: boolean };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema from zod
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  stopReason: 'end' | 'tool_use' | 'max_tokens' | 'error';
}

export interface ChatInput {
  system?: string;
  messages: Message[];
  tools?: ToolSpec[];
  signal?: AbortSignal;
}

export interface Provider {
  name: string;
  chat(input: ChatInput): Promise<ChatResult>;
}
