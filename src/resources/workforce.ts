import axios, { AxiosResponse } from "axios";
import { apiBase, getHeaders } from "../util";
import { Agent } from "./agent";
import { Conversation, ChatResponse } from "./conversation";

export interface UserData {
  id: string;
  name: string;
  email: string;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
  avatar: string;
  status: number;
  customer: string;
  resetPwdToken?: string;
  defaultWorkspace: string;
  workspaces: string[];
}

export interface WorkforceData {
  id: string;
  agents: Agent[];
  name: string;
  image: string;
  description: string;
  manager: Agent;
  creator: UserData;
  context: number;
  references: boolean;
  workspace: string;
  createdAt: string;
  updatedAt: string;
}

export class User {
  public id: string;
  public name: string;
  public email: string;
  public deleted: boolean;
  public createdAt: string;
  public updatedAt: string;
  public avatar: string;
  public status: number;
  public customer: string;
  public resetPwdToken?: string;
  public defaultWorkspace: string;
  public workspaces: string[];

  constructor(data: UserData) {
    this.id = data.id;
    this.name = data.name;
    this.email = data.email;
    this.deleted = data.deleted;
    this.createdAt = data.createdAt;
    this.updatedAt = data.updatedAt;
    this.avatar = data.avatar;
    this.status = data.status;
    this.customer = data.customer;
    this.resetPwdToken = data.resetPwdToken;
    this.defaultWorkspace = data.defaultWorkspace;
    this.workspaces = data.workspaces;
  }
}

export class Workforce {
  public id: string;
  public agents: Agent[];
  public name: string;
  public image: string;
  public description: string;
  public manager: Agent;
  public creator: User;
  public context: number;
  public references: boolean;
  public workspace: string;
  public createdAt: string;
  public updatedAt: string;

  constructor(data: WorkforceData) {
    this.id = data.id;
    this.agents = data.agents;
    this.name = data.name;
    this.image = data.image;
    this.description = data.description;
    this.manager = data.manager;
    this.creator = new User(data.creator);
    this.context = data.context;
    this.references = data.references;
    this.workspace = data.workspace;
    this.createdAt = data.createdAt;
    this.updatedAt = data.updatedAt;
  }

  async newConversation(): Promise<Conversation> {
    const url = `${apiBase()}/access/teams/${this.id}/conversations/new`;
    const response: AxiosResponse = await axios.post(
      url,
      { type: "chat" },
      { headers: getHeaders() }
    );

    if (response.status === 200) {
      const convData = response.data;
      convData.agent_id = this.manager.id;
      return new Conversation(convData);
    } else {
      throw new Error(
        `Failed to create new conversation: ${response.status} - ${response.statusText}`
      );
    }
  }

  async listConversations(): Promise<Conversation[]> {
    const url = `${apiBase()}/access/teams/${this.id}/conversations`;
    const response: AxiosResponse = await axios.get(url, {
      headers: getHeaders(),
    });

    if (response.status === 200) {
      const conversations: Conversation[] = [];
      for (const convData of response.data) {
        convData.agent_id = this.manager.id;
        conversations.push(new Conversation(convData));
      }
      return conversations;
    } else {
      throw new Error(
        `Failed to list conversations: ${response.status} - ${response.statusText}`
      );
    }
  }

  async *chatStream(
    conversationId: string,
    message: string,
    context: number = -1
  ): AsyncGenerator<ChatResponse> {
    const url = `${apiBase()}/access/teams/conversations/${conversationId}/jsonmessagesse`;
    const response: AxiosResponse = await axios.post(
      url,
      { message, context },
      {
        headers: getHeaders(),
        responseType: "stream",
      }
    );

    if (response.status === 200) {
      let result = "";
      const stream = response.data;

      for await (const chunk of stream) {
        const chunkStr = chunk.toString();
        result += chunkStr;

        try {
          // Count braces to ensure complete JSON
          const openBraces = (result.match(/\{/g) || []).length;
          const closeBraces = (result.match(/\}/g) || []).length;

          if (openBraces === closeBraces && openBraces > 0) {
            const catchJson = JSON.parse(result);
            if (catchJson) {
              result = "";
              yield {
                text: catchJson.text || null,
                cot: catchJson.cot || null,
                botId: catchJson.botId,
                reference: catchJson.reference,
                tasks: catchJson.tasks,
              };
            }
          }
        } catch (jsonError) {
          // Continue if JSON parsing fails
          continue;
        }
      }
    } else {
      throw new Error(
        `Failed to send message: ${response.status} - ${response.statusText}`
      );
    }
  }
}
