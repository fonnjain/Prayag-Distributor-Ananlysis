import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide42() {
  return (
    <Frame number={42} section="Product Tour">
      <SectionTitle eyebrow="SALES" title="Sales: Secondary Orders" subtitle="Real-time field order capture." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>Live pipeline before invoicing</Bullet>
          <Bullet>Order fulfillment rate</Bullet>
          <Bullet>Rep-level order tracking</Bullet>
          <Bullet>Identify supply shortfalls</Bullet>
        </div>
        <div className="flex-1 panel p-[2vw] relative flex flex-col gap-[2vh]">
           <div className="flex justify-between items-center bg-[#a9b7c2]/10 p-[1.5vw] rounded">
             <div className="h-[2vh] w-[20%] bg-[#1389e8]/50 rounded" />
             <div className="h-[2vh] w-[15%] bg-[#a9b7c2]/30 rounded" />
             <div className="h-[2vh] w-[15%] bg-[#4ccfa3]/50 rounded" />
           </div>
           <div className="flex justify-between items-center bg-[#a9b7c2]/10 p-[1.5vw] rounded">
             <div className="h-[2vh] w-[25%] bg-[#1389e8]/50 rounded" />
             <div className="h-[2vh] w-[15%] bg-[#a9b7c2]/30 rounded" />
             <div className="h-[2vh] w-[15%] bg-[#f3b44b]/50 rounded" />
           </div>
           <div className="flex justify-between items-center bg-[#a9b7c2]/10 p-[1.5vw] rounded">
             <div className="h-[2vh] w-[15%] bg-[#1389e8]/50 rounded" />
             <div className="h-[2vh] w-[15%] bg-[#a9b7c2]/30 rounded" />
             <div className="h-[2vh] w-[15%] bg-[#4ccfa3]/50 rounded" />
           </div>
        </div>
      </div>
    </Frame>
  );
}
