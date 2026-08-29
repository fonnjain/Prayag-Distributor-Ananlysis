import { Bullet, Frame, Pill, SectionTitle } from '../../DeckShared';

export default function Slide8() {
  return (
    <Frame number={8} section="07 / CUSTOMER & DISTRIBUTOR">
      <SectionTitle eyebrow="07 / CUSTOMER & DISTRIBUTOR" title="Find the customer and distributor opportunity" />
      <div className="absolute left-[7vw] right-[7vw] top-[41vh] grid grid-cols-[1.05fr_.95fr] gap-[1.4vw]">
        <div className="panel p-[2vw]">
          <div className="flex items-center gap-[1vw]"><div className="flex h-[4vw] w-[4vw] items-center justify-center rounded-[1vw] bg-[#1389e8]/18 text-[2vw] text-[#6ec5ff]">R</div><div><div className="thin-label">ACCOUNT SIGNAL</div><div className="mt-[.6vh] font-display text-[2vw] font-semibold">Customer intelligence</div></div></div>
          <div className="mt-[3vh] space-y-[1.8vh]"><Bullet>Rank customers and inspect individual history</Bullet><Bullet>Surface at-risk and new customers before the signal is lost</Bullet></div>
          <div className="mt-[3vh] flex items-end gap-[.55vw]"><div className="h-[5vh] w-[4vw] bg-[#1389e8]/30" /><div className="h-[8vh] w-[4vw] bg-[#1389e8]/50" /><div className="h-[12vh] w-[4vw] bg-[#1389e8]" /><div className="h-[9vh] w-[4vw] bg-[#f3b44b]/70" /></div>
        </div>
        <div className="panel p-[2vw]">
          <div className="flex items-center gap-[1vw]"><div className="flex h-[4vw] w-[4vw] items-center justify-center rounded-[1vw] bg-[#f3b44b]/18 text-[2vw] text-[#ffd58b]">D</div><div><div className="thin-label">TERRITORY SIGNAL</div><div className="mt-[.6vh] font-display text-[2vw] font-semibold">Distributor intelligence</div></div></div>
          <div className="mt-[3vh] space-y-[1.8vh]"><Bullet tone="amber">Explore distributor performance, correlation, and naming candidates</Bullet><Bullet tone="amber">Connect territory context to the account-level next step</Bullet></div>
          <div className="mt-[3vh] flex items-center justify-between"><Pill tone="amber">PERFORMANCE</Pill><div className="h-[.12vw] w-[6vw] bg-[#f3b44b]" /><Pill tone="green">NEXT STEP</Pill></div>
        </div>
      </div>
    </Frame>
  );
}