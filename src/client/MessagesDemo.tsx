import type { ReactNode } from "react";
import { Message, Messages } from "framework7-react";
import "framework7/components/messages/css";
import "./MessagesDemo.css";

/** Static conversation chrome; the embedded widget remains interactive. */
export function MessagesDemo({ prompt, children }: { prompt: string; children: ReactNode }) {
  return <div className="iphone-device"><div className="iphone-demo ios" dir="ltr" aria-label="iPhone Messages conversation preview">
    <div className="iphone-status" aria-hidden="true">
      <span>9:41</span><div className="iphone-island" />
      <svg width="62" height="16" viewBox="0 0 62 16" fill="currentColor"><rect x="0" y="10" width="3" height="5" rx="1"/><rect x="5" y="7" width="3" height="8" rx="1"/><rect x="10" y="4" width="3" height="11" rx="1"/><rect x="15" y="1" width="3" height="14" rx="1"/><path d="M23 5Q30-2 37 5L35 7Q30 2 25 7ZM26 9Q30 5 34 9L32 11Q30 9 28 11ZM28 13L30 11L32 13L30 15Z"/><rect x="42" y="3" width="17" height="11" rx="3" fill="none" stroke="currentColor"/><rect x="44" y="5" width="13" height="7" rx="1"/><rect x="60" y="6" width="2" height="5" rx="1"/></svg>
    </div>
    <div className="iphone-header">
      <div className="iphone-group" aria-hidden="true"><span>J</span><span>S</span><span>✳</span></div>
      <strong>Weekend plans</strong>
    </div>
    <Messages init={false} className="iphone-thread">
      <div className="iphone-date">iMessage<br /><span>Today 9:41 AM</span></div>
      <Message type="sent" text={prompt} first last tail footer="Delivered" />
      <Message type="received" name="Whim" text="Here you go." first last tail />
      <Message type="received" first last className="iphone-widget-message">
        {children}
      </Message>
    </Messages>
    <div className="iphone-composer" aria-hidden="true"><span className="iphone-add">+</span><div>iMessage<svg width="15" height="21" viewBox="0 0 15 21" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="5" y="1" width="5" height="11" rx="2.5"/><path d="M2 9v1a5.5 5.5 0 0 0 11 0V9M7.5 16v4M4.5 20h6"/></svg></div></div>
    <div className="iphone-home" aria-hidden="true" />
  </div></div>;
}
