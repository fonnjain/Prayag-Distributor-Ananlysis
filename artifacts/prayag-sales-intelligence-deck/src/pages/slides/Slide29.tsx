import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide29() {
  return (
    <Frame number={29} section="Product Tour">
      <SectionTitle eyebrow="REPORTING" title="Reporting: Standard Reports" subtitle="Tabular extracts of operational data." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>Pre-configured data grids</Bullet>
          <Bullet>High-density tabular layout</Bullet>
          <Bullet>Sort, filter, and paginate</Bullet>
          <Bullet>One-click CSV/Excel exports</Bullet>
        </div>
        <div className="flex-1 panel p-[1.5vw] relative flex flex-col">
          <div className="flex justify-between mb-[2vh]">
            <div className="h-[3vh] w-[20%] bg-[#1389e8]/20 rounded" />
            <div className="h-[3vh] w-[10%] bg-[#a9b7c2]/20 rounded" />
          </div>
          <div className="flex-1 border border-[#a9b7c2]/20 rounded flex flex-col overflow-hidden">
             <div className="flex bg-[#a9b7c2]/10 p-[1vh] border-b border-[#a9b7c2]/20">
               <div className="flex-1 h-[1vh] bg-[#a9b7c2]/30 rounded mr-[1vw]" />
               <div className="flex-1 h-[1vh] bg-[#a9b7c2]/30 rounded mr-[1vw]" />
               <div className="flex-1 h-[1vh] bg-[#a9b7c2]/30 rounded mr-[1vw]" />
               <div className="flex-1 h-[1vh] bg-[#a9b7c2]/30 rounded" />
             </div>
             <div className="flex p-[1vh] border-b border-[#a9b7c2]/10">
               <div className="flex-1 h-[1vh] bg-[#a9b7c2]/10 rounded mr-[1vw]" />
               <div className="flex-1 h-[1vh] bg-[#a9b7c2]/10 rounded mr-[1vw]" />
               <div className="flex-1 h-[1vh] bg-[#a9b7c2]/10 rounded mr-[1vw]" />
               <div className="flex-1 h-[1vh] bg-[#a9b7c2]/10 rounded" />
             </div>
             <div className="flex p-[1vh] border-b border-[#a9b7c2]/10">
               <div className="flex-1 h-[1vh] bg-[#a9b7c2]/10 rounded mr-[1vw]" />
               <div className="flex-1 h-[1vh] bg-[#a9b7c2]/10 rounded mr-[1vw]" />
               <div className="flex-1 h-[1vh] bg-[#a9b7c2]/10 rounded mr-[1vw]" />
               <div className="flex-1 h-[1vh] bg-[#a9b7c2]/10 rounded" />
             </div>
             <div className="flex p-[1vh] border-b border-[#a9b7c2]/10">
               <div className="flex-1 h-[1vh] bg-[#a9b7c2]/10 rounded mr-[1vw]" />
               <div className="flex-1 h-[1vh] bg-[#a9b7c2]/10 rounded mr-[1vw]" />
               <div className="flex-1 h-[1vh] bg-[#a9b7c2]/10 rounded mr-[1vw]" />
               <div className="flex-1 h-[1vh] bg-[#a9b7c2]/10 rounded" />
             </div>
             <div className="flex p-[1vh] border-b border-[#a9b7c2]/10">
               <div className="flex-1 h-[1vh] bg-[#a9b7c2]/10 rounded mr-[1vw]" />
               <div className="flex-1 h-[1vh] bg-[#a9b7c2]/10 rounded mr-[1vw]" />
               <div className="flex-1 h-[1vh] bg-[#a9b7c2]/10 rounded mr-[1vw]" />
               <div className="flex-1 h-[1vh] bg-[#a9b7c2]/10 rounded" />
             </div>
          </div>
        </div>
      </div>
    </Frame>
  );
}
