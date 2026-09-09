import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide44() {
  return (
    <Frame number={44} section="Product Tour">
      <SectionTitle eyebrow="SALES" title="Sales: Distributor Deep Dive" subtitle="Comprehensive distributor dossier." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>360-degree view of a partner</Bullet>
          <Bullet>Historical performance trend</Bullet>
          <Bullet>Credit and collection status</Bullet>
          <Bullet>SKU coverage and gaps</Bullet>
        </div>
        <div className="flex-1 panel p-[2vw] relative flex flex-col">
          <div className="flex justify-between items-start border-b border-[#a9b7c2]/20 pb-[2vh] mb-[2vh]">
            <div>
              <div className="text-[1.5vw] text-[#f5f2ea]">Apex Traders</div>
              <div className="text-[1.5vw] text-[#a9b7c2]">ID: DIS-XXXX</div>
            </div>
            <div className="text-right">
              <div className="text-[1.5vw] text-[#4ccfa3]">Active</div>
              <div className="text-[1.5vw] text-[#a9b7c2]">Since XXXX</div>
            </div>
          </div>
          <div className="flex-1 flex gap-[2vw]">
            <div className="w-[40%] flex flex-col gap-[1vh]">
              <div className="h-[2vh] w-full bg-[#1389e8]/20 rounded" />
              <div className="h-[2vh] w-[80%] bg-[#a9b7c2]/20 rounded" />
              <div className="h-[2vh] w-[90%] bg-[#a9b7c2]/20 rounded" />
            </div>
            <div className="flex-1 bg-[#a9b7c2]/5 border border-[#a9b7c2]/10 rounded flex flex-col justify-end p-[1vw]">
               <div className="flex items-end gap-[.5vw] h-[10vh]">
                 <div className="flex-1 bg-[#1389e8]/60 rounded-t" style={{ height: '40%' }} />
                 <div className="flex-1 bg-[#1389e8]/60 rounded-t" style={{ height: '60%' }} />
                 <div className="flex-1 bg-[#1389e8]/60 rounded-t" style={{ height: '45%' }} />
                 <div className="flex-1 bg-[#1389e8]/60 rounded-t" style={{ height: '80%' }} />
                 <div className="flex-1 bg-[#1389e8]/60 rounded-t" style={{ height: '75%' }} />
                 <div className="flex-1 bg-[#1389e8]/60 rounded-t" style={{ height: '90%' }} />
                 <div className="flex-1 bg-[#1389e8]/60 rounded-t" style={{ height: '85%' }} />
               </div>
            </div>
          </div>
        </div>
      </div>
    </Frame>
  );
}
