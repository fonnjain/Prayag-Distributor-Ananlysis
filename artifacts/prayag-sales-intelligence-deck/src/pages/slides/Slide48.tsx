import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide48() {
  return (
    <Frame number={48} section="Product Tour">
      <SectionTitle eyebrow="COMMERCIAL" title="Commercial: Competition" subtitle="Market share and competitor footprint." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>Share of shelf tracking</Bullet>
          <Bullet>Competitor presence by region</Bullet>
          <Bullet>Pricing parity indexing</Bullet>
          <Bullet>Identify competitive threats early</Bullet>
        </div>
        <div className="flex-1 panel p-[2vw] relative flex flex-col">
          <div className="text-[1.5vw] text-[#a9b7c2] mb-[2vh]">MARKET SHARE ESTIMATE</div>
          <div className="flex-1 flex items-center justify-center">
            <div className="w-[18vw] h-[18vw] rounded-full border-[2vw] border-[#08121f] relative">
               <div className="absolute inset-[-2vw] rounded-full border-[2vw] border-[#1389e8] border-r-transparent border-b-transparent rotate-45" />
               <div className="absolute inset-[-2vw] rounded-full border-[2vw] border-[#f3b44b] border-t-transparent border-l-transparent rotate-45" />
               <div className="absolute inset-0 flex flex-col items-center justify-center">
                 <div className="text-[3vw] text-[#f5f2ea] font-display">XX%</div>
                 <div className="text-[1.5vw] text-[#1389e8]">Prayag</div>
               </div>
            </div>
          </div>
        </div>
      </div>
    </Frame>
  );
}
