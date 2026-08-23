import axios, { AxiosResponse } from "axios";
import { apiBase, getHeaders } from "../util";
import { Conversation } from "./conversation";

export interface AgentData {
  id: string;
  name: string;
  avatar?: string;
  createdAt?: string;
  updatedAt?: string;
}

export class Agent {
  public id: string;
  public name: string;
  public avatar?: string;
  public createdAt?: string;
  public updatedAt?: string;

  constructor(data: AgentData) {
    this.id = data.id;
    this.name = data.name;
    this.avatar = data.avatar;
    this.createdAt = data.createdAt;
    this.updatedAt = data.updatedAt;
  }

  async newConversation(): Promise<Conversation> {
    const url = `${apiBase()}/access/agents/${this.id}/conversations/new`;
    const response: AxiosResponse = await axios.post(
      url,
      { type: "chat" },
      { headers: getHeaders() }
    );

    if (response.status === 200) {
      const newConv = response.data;
      newConv.id = newConv._id;
      newConv.agent_id = this.id;
      return new Conversation(newConv);
    } else {
      throw new Error(
        `Failed to create new conversation: ${response.status} - ${response.statusText}`
      );
    }
  }

  async getConversation(id: string): Promise<Conversation> {
    const conversations = await this.listConversations();
    const conversation = conversations.find((conv) => conv.id === id);
    if (!conversation) {
      throw new Error("404 - Conversation not found");
    }
    return conversation;
  }

  async listConversations(): Promise<Conversation[]> {
    const url = `${apiBase()}/access/agents/${this.id}/conversations`;
    const response: AxiosResponse = await axios.get(url, {
      headers: getHeaders(),
    });

    if (response.status === 200) {
      return response.data.map(
        (convRes: any) =>
          new Conversation({
            agent_id: this.id,
            id: convRes._id,
            title: convRes.title,
            users: convRes.users,
            agents: convRes.bots,
            createdAt: convRes.createdAt,
            updatedAt: convRes.updatedAt,
          })
      );
    } else {
      throw new Error(
        `Failed to retrieve agent details: ${response.statusText}`
      );
    }
  }
}
