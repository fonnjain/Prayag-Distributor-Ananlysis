import { Frame, Pill, SectionTitle } from '../../DeckShared';

export default function Slide3() {
  return (
    <Frame number={3} section="02 / THE DECISION GAP">
      <SectionTitle eyebrow="02 / THE DECISION GAP" title="The decision gap" subtitle="The hard part is not seeing a number. It is knowing what the number means next." />
      <div className="absolute left-[7vw] right-[7vw] top-[49vh] grid grid-cols-4 gap-[1.2vw]">
        <div className="panel h-[27vh] p-[1.6vw]"><Pill tone="blue">SCOPE</Pill><div className="mt-[2.6vh] font-display text-[1.85vw] font-semibold leading-[1.05]">Performance questions span multiple reports and data sources</div><div className="mt-[2.2vh] h-[.14vw] w-[5vw] bg-[#1389e8]" /></div>
        <div className="panel h-[27vh] p-[1.6vw]"><Pill tone="amber">CONTEXT</Pill><div className="mt-[2.6vh] font-display text-[1.85vw] font-semibold leading-[1.05]">Ownership and coverage need context, not just totals</div><div className="mt-[2.2vh] h-[.14vw] w-[5vw] bg-[#f3b44b]" /></div>
        <div className="panel h-[27vh] p-[1.6vw]"><Pill tone="green">SIGNAL</Pill><div className="mt-[2.6vh] font-display text-[1.85vw] font-semibold leading-[1.05]">Product movement, pricing, and customer risk are connected signals</div><div className="mt-[2.2vh] h-[.14vw] w-[5vw] bg-[#4ccfa3]" /></div>
        <div className="panel h-[27vh] p-[1.6vw]"><Pill tone="red">ACTION</Pill><div className="mt-[2.6vh] font-display text-[1.85vw] font-semibold leading-[1.05]">Managers need an answer they can act on in the same session</div><div className="mt-[2.2vh] h-[.14vw] w-[5vw] bg-[#ff6e66]" /></div>
      </div>
    </Frame>
  );
}