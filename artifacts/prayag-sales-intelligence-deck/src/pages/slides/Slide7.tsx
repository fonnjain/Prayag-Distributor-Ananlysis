import { Bullet, Frame, Pill, SectionTitle } from '../../DeckShared';

export default function Slide7() {
  return (
    <Frame number={7} section="06 / PERFORMANCE">
      <SectionTitle eyebrow="06 / PERFORMANCE" title="Understand performance at every level" />
      <div className="absolute left-[7vw] right-[7vw] top-[42vh] grid grid-cols-2 gap-[1.4vw]">
        <div className="panel p-[2vw]">
          <div className="flex items-center justify-between"><div className="font-display text-[2vw] font-semibold">Ownership view</div><Pill>WHO</Pill></div>
          <div className="mt-[2.7vh] space-y-[2vh]"><Bullet>State Head and Sales People views show ownership and contribution</Bullet><Bullet>Company Reports and Comparison make like-for-like review repeatable</Bullet></div>
          <div className="mt-[3vh] flex gap-[.6vw]"><span className="h-[1.3vw] w-[7vw] rounded-full bg-[#1389e8]" /><span className="h-[1.3vw] w-[4vw] rounded-full bg-[#1389e8]/45" /><span className="h-[1.3vw] w-[2vw] rounded-full bg-[#1389e8]/20" /></div>
        </div>
        <div className="panel p-[2vw]">
          <div className="flex items-center justify-between"><div className="font-display text-[2vw] font-semibold">Demand view</div><Pill tone="amber">WHAT</Pill></div>
          <div className="mt-[2.7vh] space-y-[2vh]"><Bullet tone="amber">Primary Performance separates primary sales from secondary performance</Bullet><Bullet tone="amber">Secondary Performance and Secondary Orders connect demand with booking</Bullet></div>
          <div className="mt-[3vh] flex items-center gap-[.7vw]"><div className="h-[5vw] w-[5vw] rounded-full border-[.35vw] border-[#f3b44b]/75" /><div className="h-[.12vw] w-[7vw] bg-[#f3b44b]" /><div className="h-[2.4vw] w-[2.4vw] rounded-full bg-[#f3b44b]/20 ring-[.12vw] ring-[#f3b44b]/55" /></div>
        </div>
      </div>
    </Frame>
  );
}