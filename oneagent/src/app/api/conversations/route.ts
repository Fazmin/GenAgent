import { NextResponse } from "next/server";
import { v4 as uuid } from "uuid";
import { listConversations, createConversation, getConversation } from "@/lib/db";

export async function GET() {
  try {
    const conversations = listConversations();
    return NextResponse.json(conversations);
  } catch (error) {
    console.error("Failed to list conversations:", error);
    return NextResponse.json(
      { error: "Failed to list conversations" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const id = uuid();
    const title = body.title || "New Chat";
    const provider = body.provider || "anthropic";
    const model = body.model || undefined;

    const conversation = createConversation(id, title, provider, model);
    return NextResponse.json(conversation, { status: 201 });
  } catch (error) {
    console.error("Failed to create conversation:", error);
    return NextResponse.json(
      { error: "Failed to create conversation" },
      { status: 500 }
    );
  }
}
