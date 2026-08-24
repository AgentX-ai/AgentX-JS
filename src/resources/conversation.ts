import axios, { AxiosResponse } from "axios";
import { apiBase, getHeaders } from "../util";

export interface ChatResponse {
  text: string | null;
  cot: string | null;
  botId: string;
  reference?: any;
  tasks?: any;
}

export interface Message {
  id: string;
  conversationId: string;
  role: "user" | "bot";
  botId?: string;
  userId?: string;
  text: string | null;
  cot: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationData {
  agent_id: string;
  id: string;
  title?: string;
  users: string[];
  agents: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface ContextMessage {
  user?: string;
  assistant?: string;
}

export class Conversation {
  public agent_id: string;
  public id: string;
  public title?: string;
  public users: string[];
  public agents: string[];
  public createdAt?: string;
  public updatedAt?: string;

  constructor(data: ConversationData) {
    this.agent_id = data.agent_id;
    this.id = data.id;
    this.title = data.title;
    this.users = data.users;
    this.agents = data.agents;
    this.createdAt = data.createdAt;
    this.updatedAt = data.updatedAt;
  }

  async listMessages(): Promise<Message[]> {
    const url = `${apiBase()}/access/agents/${this.agent_id}/conversations/${this.id}`;
    const response: AxiosResponse = await axios.get(url, {
      headers: getHeaders(),
    });

    if (response.status === 200) {
      const res = response.data;
      if (res.messages) {
        const messageList: Message[] = [];
        for (const message of res.messages) {
          if (message.bot) {
            message.role = "bot";
          } else {
            message.role = "user";
          }
          messageList.push(message);
        }
        return messageList;
      } else {
        throw new Error("No messages found in the conversation.");
      }
    } else {
      throw new Error(
        `Failed to retrieve agent details: ${response.status} - ${response.statusText}`
      );
    }
  }

  async chat(message: string, context?: number): Promise<any> {
    const url = `${apiBase()}/access/conversations/${this.id}/message`;
    const response: AxiosResponse = await axios.post(
      url,
      { message, context },
      { headers: getHeaders() }
    );
    return response.data;
  }

  async updateContext(messages: ContextMessage[]): Promise<void> {
    const url = `${apiBase()}/access/conversations/${this.id}/update-context`;
    const response: AxiosResponse = await axios.put(
      url,
      { messages },
      { headers: getHeaders() }
    );

    if (response.status !== 200) {
      throw new Error(
        `Failed to update conversation context: ${response.status} - ${response.statusText}`
      );
    }
  }

  async updateUserContext(message: string): Promise<void> {
    const url = `${apiBase()}/access/conversations/${this.id}/update-user-context`;
    const response: AxiosResponse = await axios.put(
      url,
      { message },
      { headers: getHeaders() }
    );

    if (response.status !== 200) {
      throw new Error(
        `Failed to update user context: ${response.status} - ${response.statusText}`
      );
    }
  }

  async *chatStream(
    message: string,
    context?: number
  ): AsyncGenerator<ChatResponse> {
    const url = `${apiBase()}/access/conversations/${this.id}/jsonmessagesse`;
    const response: AxiosResponse = await axios.post(
      url,
      { message, context },
      {
        headers: {
          ...getHeaders(),
          accept: "text/event-stream",
        },
        responseType: "stream",
      }
    );

    if (response.status === 200) {
      let buffer = "";
      const stream = response.data;

      for await (const chunk of stream) {
        const chunkStr = chunk.toString();
        buffer += chunkStr;

        // Process complete JSON objects from the buffer
        let braceCount = 0;
        let startIndex = -1;
        let processedLength = 0;

        for (let i = 0; i < buffer.length; i++) {
          if (buffer[i] === "{") {
            if (braceCount === 0) {
              startIndex = i;
            }
            braceCount++;
          } else if (buffer[i] === "}") {
            braceCount--;
            if (braceCount === 0 && startIndex !== -1) {
              // We have a complete JSON object
              const jsonStr = buffer.substring(startIndex, i + 1);

              try {
                const parsedJson = JSON.parse(jsonStr);

                // Only yield if this is a meaningful response (has text, cot, or other relevant data)
                if (
                  parsedJson.text !== undefined ||
                  parsedJson.cot !== undefined ||
                  parsedJson.tasks !== undefined
                ) {
                  yield {
                    text: parsedJson.text || null,
                    cot: parsedJson.cot || null,
                    botId: parsedJson.botId,
                    reference: parsedJson.reference,
                    tasks: parsedJson.tasks,
                  };
                }

                // Track the processed length
                processedLength = i + 1;
                startIndex = -1;
              } catch (jsonError) {
                // If JSON parsing fails, continue looking for valid JSON
                continue;
              }
            }
          }
        }

        // Remove processed JSON from buffer
        if (processedLength > 0) {
          buffer = buffer.substring(processedLength);
        }
      }

      // Handle any remaining data in buffer
      if (buffer.trim()) {
        try {
          const remainingJson = JSON.parse(buffer.trim());
          if (
            remainingJson.text !== undefined ||
            remainingJson.cot !== undefined ||
            remainingJson.tasks !== undefined
          ) {
            yield {
              text: remainingJson.text || null,
              cot: remainingJson.cot || null,
              botId: remainingJson.botId,
              reference: remainingJson.reference,
              tasks: remainingJson.tasks,
            };
          }
        } catch (jsonError) {
          // If final parsing fails, ignore the remaining buffer
          console.warn("Failed to parse remaining buffer:", buffer);
        }
      }
    } else {
      throw new Error(
        `Failed to send message: ${response.status} - ${response.statusText}`
      );
    }
  }
}
