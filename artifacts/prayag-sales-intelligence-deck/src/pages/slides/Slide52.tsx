import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide52() {
  return (
    <Frame number={52} section="Product Tour">
      <SectionTitle eyebrow="CUSTOMERS" title="Customers: At Risk & New" subtitle="Churn indicators and acquisition." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>Detect dropped buying cycles</Bullet>
          <Bullet>Intervene before silent churn</Bullet>
          <Bullet>Track new customer activation</Bullet>
          <Bullet>Net customer addition metrics</Bullet>
        </div>
        <div className="flex-1 panel p-[2vw] relative flex gap-[2vw]">
          <div className="flex-1 flex flex-col items-center justify-center gap-[1vh] border-r border-[#a9b7c2]/20">
            <div className="text-[3vw] text-[#ff6e66] font-display">XX</div>
            <div className="text-[1.5vw] text-[#e4ebef]">At Risk</div>
            <div className="text-[1.5vw] text-[#a9b7c2]">&gt; XX Days No Order</div>
          </div>
          <div className="flex-1 flex flex-col items-center justify-center gap-[1vh]">
            <div className="text-[3vw] text-[#4ccfa3] font-display">XX</div>
            <div className="text-[1.5vw] text-[#e4ebef]">New Activated</div>
            <div className="text-[1.5vw] text-[#a9b7c2]">First Order &lt; XX Days</div>
          </div>
        </div>
      </div>
    </Frame>
  );
}
