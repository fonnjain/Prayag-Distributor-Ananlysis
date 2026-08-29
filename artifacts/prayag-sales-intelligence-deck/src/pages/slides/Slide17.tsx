import { Frame, Pill, SectionTitle } from '../../DeckShared';

export default function Slide17() {
  return (
    <Frame number={17} section="16 / CONFIDENT DECISIONS">
      <SectionTitle eyebrow="16 / CONFIDENT DECISIONS" title="Designed for confident decisions" />
      <div className="absolute left-[7vw] top-[42vh] w-[38vw]">
        <div className="font-display text-[3.2vw] font-semibold leading-[1.02] tracking-[-.07em]"><div>Useful when the answer is available.</div><div className="mt-[1.2vh]">Honest when it is not.</div></div>
      </div>
      <div className="absolute right-[7vw] top-[39vh] w-[41vw] grid grid-cols-2 gap-[1vw]">
        <div className="panel p-[1.5vw]"><Pill>LANGUAGE</Pill><div className="mt-[2vh] text-[1.5vw] font-semibold">One vocabulary across dashboards, reports, and exports</div></div>
        <div className="panel p-[1.5vw]"><Pill tone="amber">SCOPE</Pill><div className="mt-[2vh] text-[1.5vw] font-semibold">Clear scope for financial year, period, geography, and owner</div></div>
        <div className="panel p-[1.5vw]"><Pill tone="green">GUARDRAILS</Pill><div className="mt-[2vh] text-[1.5vw] font-semibold">Guardrails for identity, attribution, completeness, and source freshness</div></div>
        <div className="panel p-[1.5vw]"><Pill tone="red">CLARITY</Pill><div className="mt-[2vh] text-[1.5vw] font-semibold">A decision layer that is useful when the answer is available—and honest when it is not</div></div>
      </div>
    </Frame>
  );
}