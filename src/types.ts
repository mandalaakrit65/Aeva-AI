export type ConnectionState = 'disconnected' | 'connecting' | 'idle' | 'listening' | 'speaking';

export interface ToastMessage {
  id: string;
  text: string;
  type: 'info' | 'success' | 'warn' | 'error';
}

export interface ToolCallLog {
  id: string;
  name: string;
  args: any;
  timestamp: Date;
}
