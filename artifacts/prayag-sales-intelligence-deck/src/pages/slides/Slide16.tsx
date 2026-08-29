import { Frame, IndexNumber, Pill, SectionTitle } from '../../DeckShared';

export default function Slide16() {
  return (
    <Frame number={16} section="15 / THE MANAGER LOOP">
      <SectionTitle eyebrow="15 / THE MANAGER LOOP" title="A manager's repeatable review loop" />
      <div className="absolute left-[7vw] right-[7vw] top-[40vh] flex items-start justify-between">
        <div className="w-[16vw]"><IndexNumber>01</IndexNumber><div className="mt-[1.4vh] text-[1.5vw] font-semibold">Start with the period and business headline</div></div>
        <div className="mt-[2.5vh] h-[.12vw] w-[3.5vw] bg-[#2b6286]" />
        <div className="w-[16vw]"><IndexNumber>02</IndexNumber><div className="mt-[1.4vh] text-[1.5vw] font-semibold">Drill into the state head, member, or distributor behind the change</div></div>
        <div className="mt-[2.5vh] h-[.12vw] w-[3.5vw] bg-[#2b6286]" />
        <div className="w-[16vw]"><IndexNumber>03</IndexNumber><div className="mt-[1.4vh] text-[1.5vw] font-semibold">Check customer, SKU, target, and alert context</div></div>
        <div className="mt-[2.5vh] h-[.12vw] w-[3.5vw] bg-[#2b6286]" />
        <div className="w-[16vw]"><IndexNumber tone="amber">04</IndexNumber><div className="mt-[1.4vh] text-[1.5vw] font-semibold">Choose the action: coach, visit, push, recover, or re-plan</div></div>
        <div className="mt-[2.5vh] h-[.12vw] w-[3.5vw] bg-[#2b6286]" />
        <div className="w-[16vw]"><IndexNumber tone="amber">05</IndexNumber><div className="mt-[1.4vh] text-[1.5vw] font-semibold">Return to the same view to verify movement</div></div>
      </div>
      <div className="absolute bottom-[14vh] left-[7vw] flex gap-[.8vw]"><Pill>SEE</Pill><Pill>DIAGNOSE</Pill><Pill tone="amber">ACT</Pill><Pill tone="green">VERIFY</Pill></div>
    </Frame>
  );
}