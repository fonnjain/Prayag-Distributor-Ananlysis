import { Frame, IndexNumber, Pill, SectionTitle } from '../../DeckShared';

export default function Slide4() {
  return (
    <Frame number={4} section="03 / THE DECISION FLOW">
      <SectionTitle eyebrow="03 / THE DECISION FLOW" title="A clear path from signal to action" />
      <div className="absolute left-[7vw] right-[7vw] top-[43vh] flex items-start justify-between">
        <div className="w-[19vw]"><IndexNumber>01</IndexNumber><div className="mt-[1.6vh] font-display text-[2vw] font-semibold">See</div><p className="mt-[1vh] small-copy">See the business in Overview</p></div>
        <div className="mt-[2.2vh] h-[.12vw] w-[7vw] bg-[#2a5672]" />
        <div className="w-[19vw]"><IndexNumber>02</IndexNumber><div className="mt-[1.6vh] font-display text-[2vw] font-semibold">Find</div><p className="mt-[1vh] small-copy">Find the change in Growth, Momentum, or Comparison</p></div>
        <div className="mt-[2.2vh] h-[.12vw] w-[7vw] bg-[#2a5672]" />
        <div className="w-[19vw]"><IndexNumber>03</IndexNumber><div className="mt-[1.6vh] font-display text-[2vw] font-semibold">Locate</div><p className="mt-[1vh] small-copy">Locate the opportunity in Coverage, Customers, or SKU Deep Dive</p></div>
        <div className="mt-[2.2vh] h-[.12vw] w-[7vw] bg-[#2a5672]" />
        <div className="w-[19vw]"><IndexNumber tone="amber">04</IndexNumber><div className="mt-[1.6vh] font-display text-[2vw] font-semibold">Act</div><p className="mt-[1vh] small-copy">Act through Targets, Schemes, Alerts, and follow-up workflows</p></div>
      </div>
      <div className="absolute bottom-[14vh] left-[7vw]"><Pill tone="amber">SIGNAL → DECISION → FIELD ACTION</Pill></div>
    </Frame>
  );
}