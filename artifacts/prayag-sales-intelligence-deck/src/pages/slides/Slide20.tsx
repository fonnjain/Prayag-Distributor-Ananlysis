import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide20() {
  return (
    <Frame number={20} section="Product Tour">
      <SectionTitle eyebrow="CONTEXT" title="Global Filters & Periods" subtitle="Context is applied universally across the workspace." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>Unified Provisional vs Final state</Bullet>
          <Bullet>Global date range selection</Bullet>
          <Bullet>Geography and Role filters</Bullet>
          <Bullet>Maintains consistency across all reports</Bullet>
        </div>
        <div className="flex-1 flex flex-col gap-[2vh]">
          <div className="panel p-[2vw] flex items-center gap-[2vw]">
            <div className="h-[3vh] w-[15%] bg-[#1389e8]/30 rounded" />
            <div className="h-[3vh] w-[20%] bg-[#a9b7c2]/20 rounded" />
            <div className="h-[3vh] w-[20%] bg-[#a9b7c2]/20 rounded" />
            <div className="h-[3vh] w-[15%] bg-[#f3b44b]/30 rounded ml-auto" />
          </div>
          <div className="panel p-[2vw] h-[20vh] flex flex-col gap-[2vh] opacity-60">
            <div className="h-[2vh] w-[40%] bg-[#a9b7c2]/20 rounded" />
            <div className="flex gap-[2vw]">
              <div className="h-[10vh] flex-1 bg-[#a9b7c2]/10 rounded" />
              <div className="h-[10vh] flex-1 bg-[#a9b7c2]/10 rounded" />
            </div>
          </div>
        </div>
      </div>
    </Frame>
  );
}
