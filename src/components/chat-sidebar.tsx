"use client";

import { useState } from "react";
import { playClickSound } from "@/components/kimi-ui";

export type ChatSummary = { id: string; title: string };

function ConfirmModal({
  title,
  message,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 flex items-center justify-center p-4 z-60" style={{ background: "rgba(0,0,0,0.45)" }} onClick={onCancel}>
      <div
        className="rounded-2xl p-5 w-full max-w-xs flex flex-col gap-4"
        style={{ background: "var(--paper-0)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-semibold font-display text-lg">{title}</h2>
        <p className="text-sm text-ink-600">{message}</p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              playClickSound();
              onCancel();
            }}
            className="pop-btn pop-btn-subtle rounded-full px-4 py-2 text-sm font-medium"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              playClickSound();
              onConfirm();
            }}
            className="pop-btn rounded-full text-white px-4 py-2 text-sm font-medium"
            style={
              danger
                ? { background: "var(--alert-700)", boxShadow: "0 4px 0 #7a3527, 0 5px 8px rgba(0,0,0,0.15)" }
                : { background: "var(--user-pink)", boxShadow: "0 4px 0 var(--user-pink-dark), 0 5px 8px rgba(0,0,0,0.15)" }
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  );
}

export function MenuIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="20" y2="18" />
    </svg>
  );
}

export function ChatSidebar({
  chats,
  currentChatId,
  onSelectChat,
  onNewChat,
  onDeleteChat,
  isOpen,
  onClose,
  userEmail,
  onLogout,
}: {
  chats: ChatSummary[];
  currentChatId: string | null;
  onSelectChat: (id: string) => void;
  onNewChat: () => void;
  onDeleteChat: (id: string) => void;
  isOpen: boolean;
  onClose: () => void;
  userEmail: string | null;
  onLogout: () => void;
}) {
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmLogout, setConfirmLogout] = useState(false);

  return (
    <>
      {isOpen && <div className="fixed inset-0 bg-black/40 z-40 sm:hidden" onClick={onClose} />}
      <aside
        className={`fixed sm:static inset-y-0 left-0 z-50 w-72 max-w-[82vw] h-full flex flex-col border-r border-ink-300 transition-transform duration-200 sm:translate-x-0 ${
          isOpen ? "translate-x-0" : "-translate-x-full"
        }`}
        style={{ background: "var(--paper-0)" }}
      >
        <div className="p-3 border-b border-ink-300 flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              playClickSound();
              onNewChat();
            }}
            className="pop-btn flex-1 rounded-full px-4 py-2.5 text-sm font-semibold text-white flex items-center justify-center gap-2"
            style={{ background: "var(--user-pink)", boxShadow: "0 3px 0 var(--user-pink-dark), 0 4px 6px rgba(0,0,0,0.1)" }}
          >
            <PlusIcon />
            New chat
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close sidebar"
            className="pop-btn pop-btn-subtle w-9 h-9 rounded-full flex items-center justify-center shrink-0 sm:hidden"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
          {chats.length === 0 && <p className="text-xs text-ink-600 text-center py-6 px-3">No saved chats yet — start one!</p>}
          {chats.map((chat) => (
            <div
              key={chat.id}
              onClick={() => onSelectChat(chat.id)}
              className="group flex items-center gap-1 rounded-xl px-3 py-2.5 cursor-pointer hover:bg-black/5"
              style={chat.id === currentChatId ? { background: "var(--psych-100)" } : undefined}
            >
              <span className="flex-1 text-sm truncate">{chat.title}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  playClickSound();
                  setConfirmDeleteId(chat.id);
                }}
                aria-label="Delete chat"
                className="pop-btn opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100 p-1.5 rounded-md hover:bg-black/10 shrink-0 text-ink-600"
              >
                <TrashIcon />
              </button>
            </div>
          ))}
        </div>

        <div className="p-3 border-t border-ink-300 flex items-center justify-between gap-2">
          <span className="text-xs text-ink-600 truncate">{userEmail}</span>
          <button
            type="button"
            onClick={() => {
              playClickSound();
              setConfirmLogout(true);
            }}
            className="pop-btn pop-btn-subtle rounded-full px-3 py-1.5 text-xs font-medium shrink-0"
          >
            Log out
          </button>
        </div>
      </aside>

      {confirmDeleteId && (
        <ConfirmModal
          title="Delete this chat?"
          message="This will permanently delete the conversation and everything in it. This can't be undone."
          confirmLabel="Delete"
          danger
          onConfirm={() => {
            onDeleteChat(confirmDeleteId);
            setConfirmDeleteId(null);
          }}
          onCancel={() => setConfirmDeleteId(null)}
        />
      )}

      {confirmLogout && (
        <ConfirmModal
          title="Log out?"
          message="You'll need to log back in to continue chatting with Kimi."
          confirmLabel="Log out"
          onConfirm={() => {
            setConfirmLogout(false);
            onLogout();
          }}
          onCancel={() => setConfirmLogout(false)}
        />
      )}
    </>
  );
}
