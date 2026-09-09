import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide55() {
  return (
    <Frame number={55} section="Product Tour">
      <SectionTitle eyebrow="ORGANISATION" title="Organisation: People" subtitle="Employee hierarchy and mapping." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>Visual reporting structures</Bullet>
          <Bullet>Role and territory assignments</Bullet>
          <Bullet>Automates data access scope</Bullet>
          <Bullet>Handles promotions and transfers</Bullet>
        </div>
        <div className="flex-1 panel p-[2vw] relative flex flex-col items-center justify-center">
           <div className="px-[1.5vw] py-[1vh] bg-[#1389e8]/20 border border-[#1389e8]/40 rounded text-[1.5vw] text-[#f5f2ea] mb-[2vh]">National Head</div>
           <div className="w-[1px] h-[3vh] bg-[#a9b7c2]/40" />
           <div className="w-[60%] h-[1px] bg-[#a9b7c2]/40" />
           <div className="w-[60%] flex justify-between">
             <div className="w-[1px] h-[3vh] bg-[#a9b7c2]/40" />
             <div className="w-[1px] h-[3vh] bg-[#a9b7c2]/40" />
           </div>
           <div className="w-[80%] flex justify-between">
             <div className="px-[1.5vw] py-[1vh] bg-[#a9b7c2]/10 border border-[#a9b7c2]/20 rounded text-[1.5vw] text-[#e4ebef]">Zonal Head</div>
             <div className="px-[1.5vw] py-[1vh] bg-[#a9b7c2]/10 border border-[#a9b7c2]/20 rounded text-[1.5vw] text-[#e4ebef]">Zonal Head</div>
           </div>
        </div>
      </div>
    </Frame>
  );
}
