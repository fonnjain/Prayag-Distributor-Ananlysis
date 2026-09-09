import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide22() {
  return (
    <Frame number={22} section="Product Tour">
      <SectionTitle eyebrow="DASHBOARD" title="Dashboard: Regional" subtitle="Geographic breakdown of dispatch and sales." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>State and district-level performance</Bullet>
          <Bullet>Identify high-growth vs struggling regions</Bullet>
          <Bullet>Sales density mapping</Bullet>
          <Bullet>Regional anomaly detection</Bullet>
        </div>
        <div className="flex-1 panel p-[2vw] relative flex gap-[2vw]">
          <div className="w-[40%] flex flex-col gap-[1.5vh]">
            <div className="thin-label">TOP REGIONS</div>
            <div className="h-[4vh] bg-[#1389e8]/20 rounded w-full" />
            <div className="h-[4vh] bg-[#a9b7c2]/10 rounded w-[90%]" />
            <div className="h-[4vh] bg-[#a9b7c2]/10 rounded w-[85%]" />
            <div className="h-[4vh] bg-[#a9b7c2]/10 rounded w-[95%]" />
          </div>
          <div className="flex-1 bg-[#08121f]/50 border border-[#a9b7c2]/10 rounded flex items-center justify-center relative overflow-hidden">
             <div className="w-[15vw] h-[15vw] rounded-full border border-[#1389e8]/30 flex items-center justify-center">
               <div className="w-[10vw] h-[10vw] rounded-full bg-[#1389e8]/10 flex items-center justify-center">
                 <div className="w-[5vw] h-[5vw] rounded-full bg-[#1389e8]/20" />
               </div>
             </div>
          </div>
        </div>
      </div>
    </Frame>
  );
}
