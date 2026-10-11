import { useCallback, useEffect, useRef, useState } from 'react';
import { getSupabase } from '@bussan/shared';
import type { Session } from '@supabase/supabase-js';
import calculatorHtml from '../bid-calculator/calculator.html?raw';

type HostSession = { token: string; userId: string; expiresAt: number } | null;
type CalculatorWindow = Window & { setBussanHostSession?: (session: HostSession) => void };

export default function BidCalculator() {
  const frame = useRef<HTMLIFrameElement>(null);
  const session = useRef<Session | null>(null);
  const [error, setError] = useState('');
  const deliver = useCallback(() => {
    const target = frame.current?.contentWindow as CalculatorWindow | null;
    const current = session.current;
    target?.setBussanHostSession?.(current ? {
      token: current.access_token, userId: current.user.id,
      expiresAt: (current.expires_at ?? 0) * 1000,
    } : null);
    const doc = target?.document;
    if(doc) doc.documentElement.style.fontFamily = getComputedStyle(document.documentElement).fontFamily;
  }, []);

  useEffect(() => {
    let active = true;
    const sb = getSupabase();
    // INITIAL_SESSION and subsequent refresh/sign-out events share the app's session.
    // Do not await other Supabase auth calls inside this callback.
    const { data: { subscription } } = sb.auth.onAuthStateChange((_event, next) => {
      if (!active) return;
      session.current = next;
      deliver();
    });
    return () => {
      active = false;
      subscription.unsubscribe();
      session.current = null;
      deliver();
    };
  }, [deliver]);

  return <section className="bid-calculator-page" aria-label="入札計算ツール">
    {error && <p role="alert" className="error">{error}</p>}
    <iframe ref={frame} title="ブルーレイ・モニター入札計算ツール" srcDoc={calculatorHtml}
      onLoad={deliver} onError={() => setError('計算ツールを開けませんでした。ページを再読み込みしてください。')}
      className="bid-calculator-frame" />
  </section>;
}