import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide23() {
  return (
    <Frame number={23} section="Product Tour">
      <SectionTitle eyebrow="DASHBOARD" title="Dashboard: Coverage" subtitle="Territory reach and salesforce deployment." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>Store penetration by territory</Bullet>
          <Bullet>Sales rep routing efficiency</Bullet>
          <Bullet>Identify under-serviced districts</Bullet>
          <Bullet>Coverage vs target benchmarking</Bullet>
        </div>
        <div className="flex-1 panel p-[2vw] relative flex flex-col">
          <div className="thin-label mb-[2vh]">COVERAGE METRICS</div>
          <div className="flex-1 flex items-end gap-[1.5vw] pt-[2vh] border-b border-[#a9b7c2]/20 pb-[1vh]">
             <div className="flex-1 bg-[#1389e8]/80 h-[80%] rounded-t" />
             <div className="flex-1 bg-[#a9b7c2]/40 h-[60%] rounded-t" />
             <div className="flex-1 bg-[#1389e8]/80 h-[90%] rounded-t" />
             <div className="flex-1 bg-[#a9b7c2]/40 h-[50%] rounded-t" />
             <div className="flex-1 bg-[#1389e8]/80 h-[70%] rounded-t" />
             <div className="flex-1 bg-[#a9b7c2]/40 h-[40%] rounded-t" />
          </div>
          <div className="flex justify-between mt-[1vh] text-[#a9b7c2] text-[1.5vw]">
            <span>North</span>
            <span>South</span>
            <span>East</span>
            <span>West</span>
            <span>Central</span>
            <span>NE</span>
          </div>
        </div>
      </div>
    </Frame>
  );
}
