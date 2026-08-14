import { ChatPageClient } from "@/components/chat/chat-page-client";

type Props = { params: Promise<{ chatId: string }> };

export default async function ChatDetailPage({ params }: Props) {
  const { chatId } = await params;
  return <ChatPageClient chatId={chatId} />;
}
