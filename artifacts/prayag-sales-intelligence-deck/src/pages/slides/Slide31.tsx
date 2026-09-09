import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide31() {
  return (
    <Frame number={31} section="Product Tour">
      <SectionTitle eyebrow="REPORTING" title="Reporting: Comparison" subtitle="Side-by-side metric benchmarking." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>Compare entities directly</Bullet>
          <Bullet>Identify out-performers</Bullet>
          <Bullet>Normalize data for fair benchmarking</Bullet>
          <Bullet>Visual delta indicators</Bullet>
        </div>
        <div className="flex-1 panel p-[2vw] relative flex gap-[2vw]">
          <div className="flex-1 flex flex-col gap-[1.5vh]">
            <div className="text-[1.5vw] text-[#f5f2ea] text-center border-b border-[#1389e8]/50 pb-[1vh]">Region A</div>
            <div className="h-[3vh] bg-[#a9b7c2]/20 rounded w-full" />
            <div className="h-[3vh] bg-[#a9b7c2]/20 rounded w-[80%]" />
            <div className="h-[3vh] bg-[#a9b7c2]/20 rounded w-[90%]" />
          </div>
          <div className="w-[1px] bg-[#a9b7c2]/20" />
          <div className="flex-1 flex flex-col gap-[1.5vh]">
            <div className="text-[1.5vw] text-[#f5f2ea] text-center border-b border-[#f3b44b]/50 pb-[1vh]">Region B</div>
            <div className="h-[3vh] bg-[#a9b7c2]/10 rounded w-full" />
            <div className="h-[3vh] bg-[#a9b7c2]/10 rounded w-[60%]" />
            <div className="h-[3vh] bg-[#a9b7c2]/10 rounded w-[70%]" />
          </div>
        </div>
      </div>
    </Frame>
  );
}
