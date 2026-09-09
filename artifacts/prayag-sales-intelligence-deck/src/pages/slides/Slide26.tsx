import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide26() {
  return (
    <Frame number={26} section="Product Tour">
      <SectionTitle eyebrow="DASHBOARD" title="Dashboard: Growth" subtitle="Year-over-year and period comparisons." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>Multi-period benchmarking</Bullet>
          <Bullet>Absolute and percentage growth</Bullet>
          <Bullet>Isolate cyclical trends</Bullet>
          <Bullet>Category specific growth drivers</Bullet>
        </div>
        <div className="flex-1 panel p-[2vw] relative flex flex-col gap-[3vh]">
          <div className="flex gap-[2vw]">
            <div className="flex-1 h-[8vh] bg-[#4ccfa3]/10 border border-[#4ccfa3]/30 rounded flex items-center justify-center text-[#4ccfa3] text-[2vw]">+XX.X% YoY</div>
            <div className="flex-1 h-[8vh] bg-[#f3b44b]/10 border border-[#f3b44b]/30 rounded flex items-center justify-center text-[#f3b44b] text-[2vw]">-X.X% MoM</div>
          </div>
          <div className="flex-1 flex gap-[1vw] items-end pb-[1vh]">
            <div className="flex-1 h-[60%] bg-[#a9b7c2]/20 rounded-t" />
            <div className="flex-1 h-[80%] bg-[#1389e8]/50 rounded-t" />
            <div className="w-[2vw]" />
            <div className="flex-1 h-[70%] bg-[#a9b7c2]/20 rounded-t" />
            <div className="flex-1 h-[65%] bg-[#f3b44b]/50 rounded-t" />
            <div className="w-[2vw]" />
            <div className="flex-1 h-[50%] bg-[#a9b7c2]/20 rounded-t" />
            <div className="flex-1 h-[90%] bg-[#4ccfa3]/50 rounded-t" />
          </div>
        </div>
      </div>
    </Frame>
  );
}
